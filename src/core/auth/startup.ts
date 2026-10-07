import type { IdentityMode } from "../db/migrations/identity-mode.js";
import { isUsableBucketRule } from "../http/rate-limit.js";
import { KEY_PURPOSES, type KeyProvider } from "../keys/index.js";
import { keyTakesMac } from "../keys/mac.js";
import { isIntegrityPurpose } from "../keys/purpose.js";
import { type GenericProviderConfig, KNOWN_PROVIDERS } from "../oauth/config.js";
import type { BaseConfig } from "./config.js";

type StartupErrorCode =
	| "keys_missing"
	| "keys_unusable"
	| "origins_empty"
	| "email_callback_missing"
	| "recovery_codes_required"
	| "recovery_code_shape_unusable"
	| "oauth_provider_incomplete"
	| "rate_limit_bucket_unusable"
	| "plugin_id_duplicated"
	| "plugin_dependency_missing"
	| "plugin_dependency_cycle"
	| "plugin_route_conflict"
	| "plugin_field_unknown"
	| "plugin_route_reads_a_core_cookie"
	| "plugin_route_exempts_the_origin_check"
	| "plugin_route_without_address_rate_limit"
	| "plugin_table_prefix_conflict"
	| "plugin_migration_table_not_prefixed"
	| "plugin_migration_table_not_an_identifier"
	| "plugin_error_code_not_namespaced"
	| "plugin_error_code_undeclared"
	| "plugin_rate_limit_rule_unmatched"
	| "plugin_database_and_role_both_set"
	| "plugin_database_reaches_the_core"
	| "route_namespace_conflict"
	| "route_name_segment_reserved";

const MESSAGE_BY_STARTUP_ERROR_CODE: Readonly<Record<StartupErrorCode, string>> = {
	keys_missing: "keys is required: every purpose key is derived from a root key of 32 bytes",
	keys_unusable: "keys did not answer for every purpose, so no protected value could be written",
	origins_empty:
		"origins must name at least one allowed origin; an empty list is not a blanket permission",
	email_callback_missing:
		'email.send is required in the identity modes "email" and "username_email"',
	recovery_codes_required:
		'identity.mode "username" requires recoveryCodes: without an address there is no other way back into an account',
	recovery_code_shape_unusable:
		"recoveryCodes.count and recoveryCodes.groupSize must each be a positive whole number: a count of nothing is a set with no way back in, and a group of nothing never ends",
	oauth_provider_incomplete:
		"a provider id that is not one of the fourteen built in needs authorizationEndpoint, tokenEndpoint and subjectClaim",
	rate_limit_bucket_unusable:
		'rateLimit.perIpAddress and rateLimit.perAccount must each be a bucket of a finite capacity and refill rate of at least zero; "none" would take every core route out of that bucket, and S-DEFAULT-3 leaves no option that switches the rate limit off',
	plugin_id_duplicated: "two plugins claim the same id, so neither owns its namespace",
	plugin_dependency_missing:
		"a plugin declares a dependency on a plugin that is not configured, so nothing can order the two",
	plugin_dependency_cycle: "the plugins depend on one another in a cycle, which has no order",
	plugin_route_conflict:
		"a plugin route collides with a core route or with another plugin's; 3.11 makes that a start error and not a warning",
	plugin_field_unknown:
		"a plugin carries a field the interface does not enumerate; the extension points are enumerated and the security middleware is not one of them (S-CSRF-6)",
	plugin_route_reads_a_core_cookie:
		'a plugin route declares caller "pending", pendingCookie or oauthStateCookie; 3.6 names the four routes __Host-velve_pending authorises and the two that read it, and a plugin route is none of them',
	plugin_route_exempts_the_origin_check:
		'a plugin route declares an originCheck other than "checked"; S-CSRF-1 leaves the OAuth callback as the only route without it, and exempting one is how a plugin bypasses it (S-CSRF-6)',
	plugin_route_without_address_rate_limit:
		'a plugin route declares perIpAddress "none" or no usable address bucket; 3.11 puts the rate limit in front of every plugin route and S-DEFAULT-3 leaves no option that switches it off',
	plugin_table_prefix_conflict:
		"one plugin id is the table prefix of another, so a table would belong to both of them (S-DEFAULT-5)",
	plugin_migration_table_not_prefixed:
		"a plugin migration declares a table outside its own prefix; 3.11 gives a plugin the tables named <plugin-id>_ and no others",
	plugin_migration_table_not_an_identifier:
		"a plugin migration declares a table name that is not a plain lowercase identifier of at most 63 bytes, so the name could not be read back as the one table it spells",
	plugin_error_code_not_namespaced:
		"a plugin declares an error code outside its own namespace, which would let two plugins answer for one code (S-DEFAULT-5)",
	plugin_error_code_undeclared:
		"a plugin route names an error code the plugin does not declare in errorCodes, so the caller would be answered internal_error for a code the route promises",
	plugin_rate_limit_rule_unmatched:
		"a plugin declares a rateLimitRules entry for a route it does not contribute, so the rule would limit nothing",
	plugin_database_and_role_both_set:
		"pluginDatabase and pluginDatabaseRole are both set; plugin SQL runs either over its own login connection or under a role the library's connection switches to, and not both",
	plugin_database_reaches_the_core:
		"pluginDatabase logs in as a role that is the library's role, can become it, owns the schema or holds a right on a core table, so it is no boundary around plugin SQL",
	route_namespace_conflict:
		"two route names fold onto the same object path, so one server method would shadow the other",
	route_name_segment_reserved:
		"a route name has a segment every object already carries — __proto__, constructor or prototype — and the object path it folds into is not the library's to give away",
};

/** the two contributors a route conflict names in its start error */
export interface RouteConflict {
	readonly claimed: string;
	readonly contributors: readonly [string, string];
}

/** the name the library goes by as one of the two contributors to a route conflict */
export const THE_CORE = "the core";

function namesBothContributors(conflict: RouteConflict): string {
	const [first, second] = conflict.contributors;
	return `${conflict.claimed} is claimed by ${first} and by ${second}`;
}

export class VelveStartupError extends Error {
	readonly code: StartupErrorCode;
	/** present where the code is a conflict between two contributors, and absent otherwise */
	readonly conflict?: RouteConflict;

	constructor(code: StartupErrorCode, conflict?: RouteConflict) {
		const stated = MESSAGE_BY_STARTUP_ERROR_CODE[code];
		super(conflict === undefined ? stated : `${stated} [${namesBothContributors(conflict)}]`);
		this.name = "VelveStartupError";
		this.code = code;
		if (conflict !== undefined) {
			this.conflict = conflict;
		}
	}
}

function looksLikeKeyProvider(keys: unknown): keys is KeyProvider {
	return (
		typeof keys === "object" &&
		keys !== null &&
		typeof (keys as KeyProvider).current === "function" &&
		typeof (keys as KeyProvider).byVersion === "function"
	);
}

//a missing keys field must refuse the start like a root key below 32 bytes (S-KEY-6)
function assertKeysArePresent(keys: unknown): asserts keys is KeyProvider {
	if (!looksLikeKeyProvider(keys)) {
		throw new VelveStartupError("keys_missing");
	}
}

function assertOriginsAreNamed(origins: readonly string[] | undefined): void {
	if (origins === undefined || origins.length === 0) {
		throw new VelveStartupError("origins_empty");
	}
}

//callers from JavaScript bypass the type, so it is checked at runtime too (S-DEFAULT-4)
function assertRecoveryCodesWhereTheyAreTheOnlyWayBack(
	mode: IdentityMode,
	recoveryCodes: unknown,
): void {
	if (mode === "username" && recoveryCodes === undefined) {
		throw new VelveStartupError("recovery_codes_required");
	}
}

//numbers the type admits but nobody can honour are refused, not narrowed silently (E-1696)
function isUsableShapeField(configured: unknown): boolean {
	return (
		configured === undefined ||
		(typeof configured === "number" && Number.isSafeInteger(configured) && configured > 0)
	);
}

function assertRecoveryCodeShapeIsUsable(recoveryCodes: unknown): void {
	if (typeof recoveryCodes !== "object" || recoveryCodes === null) {
		return;
	}
	const { count, groupSize } = recoveryCodes as { count?: unknown; groupSize?: unknown };
	if (!isUsableShapeField(count) || !isUsableShapeField(groupSize)) {
		throw new VelveStartupError("recovery_code_shape_unusable");
	}
}

function assertEmailCallbackWhereAddressesExist(mode: IdentityMode, email: unknown): void {
	if (mode !== "username" && email === undefined) {
		throw new VelveStartupError("email_callback_missing");
	}
}

//an id the library has no endpoints for must carry its own or the start fails
function assertEveryUnknownProviderCarriesItsEndpoints(oauth: unknown): void {
	if (typeof oauth !== "object" || oauth === null) {
		return;
	}
	const providers = (oauth as { providers?: unknown }).providers;
	if (typeof providers !== "object" || providers === null) {
		return;
	}
	for (const [id, entry] of Object.entries(providers as Record<string, unknown>)) {
		if (KNOWN_PROVIDERS.includes(id as (typeof KNOWN_PROVIDERS)[number])) {
			continue;
		}
		const generic = entry as Partial<GenericProviderConfig> | null;
		if (
			typeof generic?.authorizationEndpoint !== "string" ||
			typeof generic.tokenEndpoint !== "string" ||
			typeof generic.subjectClaim !== "string"
		) {
			throw new VelveStartupError("oauth_provider_incomplete");
		}
	}
}

//a javascript caller can hand over the none a route rule allows and it must not reach a core route (E-2215)
function assertEveryConfiguredBucketIsUsable(rateLimit: unknown): void {
	if (typeof rateLimit !== "object" || rateLimit === null) {
		return;
	}
	const { perIpAddress, perAccount } = rateLimit as {
		perIpAddress?: unknown;
		perAccount?: unknown;
	};
	for (const bucket of [perIpAddress, perAccount]) {
		if (bucket !== undefined && !isUsableBucketRule(bucket)) {
			throw new VelveStartupError("rate_limit_bucket_unusable");
		}
	}
}

//plugin sql must have one place to run so neither option silently overrides the other (E-2642)
function assertPluginSqlHasOneDestination(config: {
	readonly pluginDatabase?: unknown;
	readonly pluginDatabaseRole?: unknown;
}): void {
	if (config.pluginDatabase !== undefined && config.pluginDatabaseRole !== undefined) {
		throw new VelveStartupError("plugin_database_and_role_both_set");
	}
}

//checks that need the database cannot run here, as building the instance is synchronous (E-179)
export function assertConfigurationIsStartable<M extends IdentityMode>(
	config: BaseConfig<M> & { readonly recoveryCodes?: unknown },
): void {
	assertKeysArePresent(config.keys);
	assertOriginsAreNamed(config.origins);
	assertRecoveryCodesWhereTheyAreTheOnlyWayBack(config.identity.mode, config.recoveryCodes);
	assertRecoveryCodeShapeIsUsable(config.recoveryCodes);
	assertEmailCallbackWhereAddressesExist(config.identity.mode, config.email);
	assertEveryUnknownProviderCarriesItsEndpoints(config.oauth);
	assertEveryConfiguredBucketIsUsable(config.rateLimit);
	assertPluginSqlHasOneDestination(config);
}

//a key provider that answers for no purpose protects nothing and must refuse the start
export async function assertKeysAnswerForEveryPurpose(keys: KeyProvider): Promise<void> {
	for (const purpose of KEY_PURPOSES) {
		const current = await keys.current(purpose).catch(() => null);
		if (current === null || !Number.isInteger(current.version) || current.version < 1) {
			throw new VelveStartupError("keys_unusable");
		}
		if (isIntegrityPurpose(purpose) && !(await keyTakesMac(current.key))) {
			throw new VelveStartupError("keys_unusable");
		}
	}
}
