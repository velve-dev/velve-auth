import type { IdentityMode } from "../db/migrations/identity-mode.js";
import { DEFAULT_RECOVERY_CODE_SHAPE } from "../factor/recovery/code.js";
import { TOTP_TOLERANCE_STEPS } from "../factor/totp/parameters.js";
import { DEFAULT_REGISTRATION_USER_VERIFICATION } from "../factor/webauthn/config.js";
import type { BucketRule } from "../http/rate-limit.js";
import { ARGON2ID_FLOOR } from "../password/config.js";
import { DEFAULT_SESSION_CONFIG, type SessionSettings } from "../session/config.js";
import { DEFAULT_SESSION_METADATA_MODE } from "../session/metadata.js";
import type { BaseConfig, RateLimitConfig, VelveAuthConfig } from "./config.js";
import { rateLimitConfigOf } from "./rate-limiting.js";

/** every key of the option type */
type OptionKey = keyof VelveAuthConfig<IdentityMode>;

export interface SecurityOption {
	readonly option: OptionKey;
	/** what the library uses when the option is absent */
	readonly safeDefault: string;
	/** what a caller has to write to make it weaker, or the sentence saying nothing does */
	readonly weakenedBy: string;
}

const NOTHING_WEAKENS_IT = "nothing weakens it";
const REQUIRED = "no default: the option is required";

//a stated default is read from the value the code uses and never written a second time (S-DEFAULT-1)
const DEFAULT_RATE_LIMIT = rateLimitConfigOf();

function bucketAsWritten(rule: BucketRule): string {
	return `${rule.capacity} @ ${rule.refillPerSecond}/s`;
}

function sameSiteAsWritten(sameSite: string): string {
	return `${sameSite.charAt(0).toUpperCase()}${sameSite.slice(1)}`;
}

const SESSION_DEFAULT = `idle ${DEFAULT_SESSION_CONFIG.idleTimeout}, absolute ${DEFAULT_SESSION_CONFIG.absoluteTimeout}, freshness ${DEFAULT_SESSION_CONFIG.freshnessWindow}, SameSite=${sameSiteAsWritten(DEFAULT_SESSION_CONFIG.cookie.sameSite)}`;
const RATE_LIMIT_DEFAULT = `per address ${bucketAsWritten(DEFAULT_RATE_LIMIT.perIpAddress)}, per account ${bucketAsWritten(DEFAULT_RATE_LIMIT.perAccount)}`;

/** every option with its safe default and what a caller has to write to weaken it */
export const SECURITY_OPTIONS: readonly SecurityOption[] = [
	{ option: "database", safeDefault: REQUIRED, weakenedBy: NOTHING_WEAKENS_IT },
	{ option: "identity", safeDefault: REQUIRED, weakenedBy: NOTHING_WEAKENS_IT },
	{ option: "keys", safeDefault: REQUIRED, weakenedBy: NOTHING_WEAKENS_IT },
	{ option: "origins", safeDefault: REQUIRED, weakenedBy: NOTHING_WEAKENS_IT },
	{
		option: "password",
		safeDefault: `argon2id m=${ARGON2ID_FLOOR.memoryKiB}, t=${ARGON2ID_FLOOR.iterations}, p=${ARGON2ID_FLOOR.parallelism}`,
		weakenedBy: "nothing: weaker parameters are refused at start (S-DEFAULT-6)",
	},
	{
		option: "session",
		safeDefault: SESSION_DEFAULT,
		weakenedBy:
			"an idle timeout, an absolute timeout or a freshness window longer than the default",
	},
	{
		option: "sessionMetadata",
		safeDefault: DEFAULT_SESSION_METADATA_MODE,
		weakenedBy: '"full", which lifts the truncation L-10 asks for',
	},
	{
		option: "trustedProxies",
		safeDefault: "[]",
		weakenedBy: "any entry, because each one makes an X-Forwarded-For header count",
	},
	{
		option: "rateLimit",
		safeDefault: RATE_LIMIT_DEFAULT,
		weakenedBy: "a capacity or a refill rate above the default, per address or per account",
	},
	{
		option: "email",
		safeDefault: "no default: the send callback is optional",
		weakenedBy: NOTHING_WEAKENS_IT,
	},
	{
		option: "oauth",
		safeDefault: "no default: third-party sign-in is optional, and no token is stored",
		weakenedBy:
			"an entry in trustedProviders, which is the third of S-LINK-2's three conditions, or storeTokens: true",
	},
	{
		option: "fetch",
		safeDefault: "globalThis.fetch",
		weakenedBy: "any other implementation, because it sees every outbound provider request",
	},
	{
		option: "plugins",
		safeDefault: "[]",
		weakenedBy:
			"any entry, because a hook can refuse a sign-in the core would have allowed; without pluginDatabase the line also says whether plugin SQL runs as pluginDatabaseRole or as the library's own role",
	},
	{
		option: "pluginDatabaseRole",
		safeDefault:
			"no default: without it plugin SQL runs as the library's own role, bounded by the statement check alone (E-738)",
		weakenedBy:
			"nothing: leaving it out is reported in the plugins line, the one option that gives a plugin SQL to run",
	},
	{
		option: "pluginDatabase",
		safeDefault:
			"no default: without it plugin SQL runs on the library's own connection, under pluginDatabaseRole when that is set",
		weakenedBy:
			"nothing: a login that is the library's role, can become it or reaches a core table is refused when migrate() runs",
	},
	{
		option: "webauthn",
		safeDefault: "no default: the relying party is optional",
		weakenedBy: '"preferred" user verification, which admits an unverified second factor',
	},
	{
		option: "totp",
		safeDefault: `issuer required, tolerance ${TOTP_TOLERANCE_STEPS} step`,
		weakenedBy: "nothing: a tolerance above one step is not applied (A.8, E-1693)",
	},
	{
		option: "recoveryCodes",
		safeDefault: `${DEFAULT_RECOVERY_CODE_SHAPE.count} codes in groups of ${DEFAULT_RECOVERY_CODE_SHAPE.groupSize}`,
		weakenedBy: "fewer than ten codes",
	},
	{ option: "schema", safeDefault: "velve", weakenedBy: NOTHING_WEAKENS_IT },
	{
		option: "clock",
		safeDefault: "the system clock",
		weakenedBy: "any other clock, because a settable one belongs to a test run",
	},
	{
		option: "log",
		safeDefault: "no default: the sink is optional",
		weakenedBy: NOTHING_WEAKENS_IT,
	},
];

export interface ChosenWeakening {
	readonly option: OptionKey;
	readonly chosen: string;
}

interface ResolvedDefaults<Resolved> {
	readonly defaults: Resolved;
	readonly chosen: Resolved;
}

interface ResolvedSettings {
	readonly session: ResolvedDefaults<SessionSettings>;
	readonly rateLimit: ResolvedDefaults<RateLimitConfig>;
}

type ObservedConfig = BaseConfig<IdentityMode> & {
	readonly recoveryCodes?: { readonly count: number };
};

type Detector = (config: ObservedConfig, resolved: ResolvedSettings) => ChosenWeakening | null;

const SESSION_DEADLINES = ["idleTimeoutMs", "absoluteTimeoutMs", "freshnessWindowMs"] as const;

function sessionDeadlinesLongerThanTheDefault(
	session: ResolvedDefaults<SessionSettings>,
): string[] {
	return SESSION_DEADLINES.filter(
		(deadline) => session.chosen[deadline] > session.defaults[deadline],
	).map((deadline) => `${deadline} ${session.chosen[deadline]}`);
}

function admitsMoreThan(chosen: BucketRule, defaults: BucketRule): boolean {
	return chosen.capacity > defaults.capacity || chosen.refillPerSecond > defaults.refillPerSecond;
}

function userVerificationOf(config: ObservedConfig): string {
	return config.webauthn?.userVerification ?? DEFAULT_REGISTRATION_USER_VERIFICATION;
}

//plugin sql on the library connection can always return to the library role and read the core (S-OWNER-10)
function pluginSqlBoundOf(config: ObservedConfig): string {
	if (config.pluginDatabase !== undefined) {
		return "";
	}
	return config.pluginDatabaseRole === undefined
		? "; plugin SQL runs as the library's own role, as no pluginDatabaseRole is set"
		: `; plugin SQL runs as role ${config.pluginDatabaseRole} on the library's connection, which bounds its writes and leaves its reads of core tables to the statement check, as no pluginDatabase is set`;
}

//one detector per option, so a new option adds a row rather than a branch
const DETECTORS: readonly Detector[] = [
	(_config, { session }) => {
		const longer = sessionDeadlinesLongerThanTheDefault(session);
		return longer.length > 0 ? { option: "session", chosen: longer.join(", ") } : null;
	},

	(config) =>
		config.sessionMetadata !== undefined && config.sessionMetadata !== "truncated"
			? { option: "sessionMetadata", chosen: config.sessionMetadata }
			: null,

	(config) =>
		config.trustedProxies !== undefined && config.trustedProxies.length > 0
			? { option: "trustedProxies", chosen: `${config.trustedProxies.length} trusted range(s)` }
			: null,

	(_config, { rateLimit }) => {
		const { chosen, defaults } = rateLimit;
		return admitsMoreThan(chosen.perIpAddress, defaults.perIpAddress) ||
			admitsMoreThan(chosen.perAccount, defaults.perAccount)
			? {
					option: "rateLimit",
					chosen: `per address ${bucketAsWritten(chosen.perIpAddress)}, per account ${bucketAsWritten(chosen.perAccount)}`,
				}
			: null;
	},

	(config) =>
		userVerificationOf(config) === DEFAULT_REGISTRATION_USER_VERIFICATION
			? null
			: { option: "webauthn", chosen: userVerificationOf(config) },

	(config) => {
		const count = config.recoveryCodes?.count ?? DEFAULT_RECOVERY_CODE_SHAPE.count;
		return count < DEFAULT_RECOVERY_CODE_SHAPE.count
			? { option: "recoveryCodes", chosen: `${count} codes` }
			: null;
	},

	(config) => {
		const trusted = config.oauth?.trustedProviders ?? [];
		const stored = config.oauth?.storeTokens === true;
		if (trusted.length === 0 && !stored) {
			return null;
		}
		const parts = [
			trusted.length > 0 ? `${trusted.length} trusted provider(s)` : null,
			stored ? "provider tokens stored" : null,
		].filter((part): part is string => part !== null);
		return { option: "oauth", chosen: parts.join(", ") };
	},

	(config) =>
		config.fetch === undefined ? null : { option: "fetch", chosen: "a fetch the caller supplied" },

	(config) =>
		config.plugins !== undefined && config.plugins.length > 0
			? {
					option: "plugins",
					chosen: `${config.plugins.map((plugin) => plugin.id).join(", ")}${pluginSqlBoundOf(config)}`,
				}
			: null,

	(config) =>
		config.clock === undefined ? null : { option: "clock", chosen: "a clock the caller supplied" },
];

//each weakened option appears once, as the operator reads what was given up (S-DEFAULT-1)
export function weakeningsIn<M extends IdentityMode>(
	config: BaseConfig<M> & { readonly recoveryCodes?: { readonly count: number } },
	resolved: ResolvedSettings,
): readonly ChosenWeakening[] {
	const observed = config as ObservedConfig;
	return DETECTORS.map((detect) => detect(observed, resolved)).filter(
		(weakening): weakening is ChosenWeakening => weakening !== null,
	);
}
