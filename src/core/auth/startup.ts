import type { IdentityMode } from "../db/migrations/identity-mode.js";
import { KEY_PURPOSES, type KeyProvider } from "../keys/index.js";
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
	| "plugin_id_duplicated"
	| "plugin_dependency_missing"
	| "plugin_dependency_cycle"
	| "plugin_route_conflict"
	| "plugin_field_unknown"
	| "plugin_route_reads_a_core_cookie"
	| "plugin_route_exempts_the_origin_check"
	| "plugin_table_prefix_conflict"
	| "plugin_migration_table_not_prefixed"
	| "plugin_error_code_not_namespaced"
	| "plugin_error_code_undeclared"
	| "plugin_rate_limit_rule_unmatched"
	| "route_namespace_conflict"
	| "route_name_segment_reserved";

const MESSAGE_BY_STARTUP_ERROR_CODE: Readonly<Record<StartupErrorCode, string>> = {
	keys_missing: "keys is required: the six purpose keys are derived from a root key of 32 bytes",
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
	plugin_id_duplicated: "two plugins claim the same id, so neither owns its namespace",
	plugin_dependency_missing:
		"a plugin declares a dependency on a plugin that is not configured, so nothing can order the two",
	plugin_dependency_cycle: "the plugins depend on one another in a cycle, which has no order",
	plugin_route_conflict:
		"a plugin route collides with a core route or with another plugin's; 3.11 makes that a start error and not a warning",
	plugin_field_unknown:
		"a plugin carries a field the interface does not enumerate; the extension points are enumerated and the security middleware is not one of them (S-CSRF-6)",
	plugin_route_reads_a_core_cookie:
		'a plugin route declares caller "pending", pendingCookie or oauthStateCookie; 3.6 names the four routes that read __Host-velve_pending and a plugin route is not one of them',
	plugin_route_exempts_the_origin_check:
		'a plugin route declares an originCheck other than "checked"; S-CSRF-1 leaves the OAuth callback as the only route without it, and exempting one is how a plugin bypasses it (S-CSRF-6)',
	plugin_table_prefix_conflict:
		"one plugin id is the table prefix of another, so a table would belong to both of them (S-DEFAULT-5)",
	plugin_migration_table_not_prefixed:
		"a plugin migration declares a table outside its own prefix; 3.11 gives a plugin the tables named <plugin-id>_ and no others",
	plugin_error_code_not_namespaced:
		"a plugin declares an error code outside its own namespace, which would let two plugins answer for one code (S-DEFAULT-5)",
	plugin_error_code_undeclared:
		"a plugin route names an error code the plugin does not declare in errorCodes, so the caller would be answered internal_error for a code the route promises",
	plugin_rate_limit_rule_unmatched:
		"a plugin declares a rateLimitRules entry for a route it does not contribute, so the rule would limit nothing",
	route_namespace_conflict:
		"two route names fold onto the same object path, so one server method would shadow the other",
	route_name_segment_reserved:
		"a route name has a segment every object already carries — __proto__, constructor or prototype — and the object path it folds into is not the library's to give away",
};

/**
 * T-OWNER-11 asks the start error to name both contributors to a route conflict.
 */
export interface RouteConflict {
	readonly claimed: string;
	readonly contributors: readonly [string, string];
}

/** A conflict has two contributors even where one of them is the library, so the library has a name (E-1342). */
export const THE_CORE = "the core";

function namesBothContributors(conflict: RouteConflict): string {
	const [first, second] = conflict.contributors;
	return `${conflict.claimed} is claimed by ${first} and by ${second}`;
}

export class VelveStartupError extends Error {
	readonly code: StartupErrorCode;
	/** Present where the code is a conflict between two contributors, and absent otherwise. */
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

/** S-KEY-6: a missing `keys` field refuses the start, exactly as a root key below 32 bytes does. */
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

/** S-DEFAULT-4, E-207: the runtime half of `RecoveryCodesRequirement`, for callers from JavaScript. */
function assertRecoveryCodesWhereTheyAreTheOnlyWayBack(
	mode: IdentityMode,
	recoveryCodes: unknown,
): void {
	if (mode === "username" && recoveryCodes === undefined) {
		throw new VelveStartupError("recovery_codes_required");
	}
}

/**
 * A.8 types both fields `number`, and the two values that type admits which cannot be honoured are
 * refused here rather than narrowed silently where they are read (E-1696).
 */
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

/**
 * The type admits credentials alone for every id so that a known provider needs no endpoints; only
 * an id the library has no endpoints for has to carry its own, and 3.11 makes that a start error.
 */
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

/**
 * The synchronous half of the start, run while `createVelveAuth` builds the instance. What needs
 * the database — the stored key versions of E-179 — cannot run here, because the interface of 3.15
 * B is synchronous; `migrate` carries it.
 */
export function assertConfigurationIsStartable<M extends IdentityMode>(
	config: BaseConfig<M> & { readonly recoveryCodes?: unknown },
): void {
	assertKeysArePresent(config.keys);
	assertOriginsAreNamed(config.origins);
	assertRecoveryCodesWhereTheyAreTheOnlyWayBack(config.identity.mode, config.recoveryCodes);
	assertRecoveryCodeShapeIsUsable(config.recoveryCodes);
	assertEmailCallbackWhereAddressesExist(config.identity.mode, config.email);
	assertEveryUnknownProviderCarriesItsEndpoints(config.oauth);
}

/** S-KEY-6, second half: a provider that answers for no purpose protects nothing. */
export async function assertKeysAnswerForEveryPurpose(keys: KeyProvider): Promise<void> {
	for (const purpose of KEY_PURPOSES) {
		const current = await keys.current(purpose).catch(() => null);
		if (current === null || !Number.isInteger(current.version) || current.version < 1) {
			throw new VelveStartupError("keys_unusable");
		}
	}
}
