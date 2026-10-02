import type { IdentityMode } from "../db/migrations/identity-mode.js";
import { DEFAULT_SESSION_METADATA_MODE } from "../session/metadata.js";
import type { BaseConfig, VelveAuthConfig } from "./config.js";

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

/** every option with its safe default and what a caller has to write to weaken it */
export const SECURITY_OPTIONS: readonly SecurityOption[] = [
	{ option: "database", safeDefault: REQUIRED, weakenedBy: NOTHING_WEAKENS_IT },
	{ option: "identity", safeDefault: REQUIRED, weakenedBy: NOTHING_WEAKENS_IT },
	{ option: "keys", safeDefault: REQUIRED, weakenedBy: NOTHING_WEAKENS_IT },
	{ option: "origins", safeDefault: REQUIRED, weakenedBy: NOTHING_WEAKENS_IT },
	{
		option: "password",
		safeDefault: "argon2id m=19456, t=2, p=1",
		weakenedBy: "nothing: weaker parameters are refused at start (S-DEFAULT-6)",
	},
	{
		option: "session",
		safeDefault: "idle 7d, absolute 30d, freshness 15m, SameSite=Lax",
		weakenedBy: "a freshness window wider than the default",
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
		safeDefault: "per address 10 @ 0.1/s, per account 5 @ 0.01/s",
		weakenedBy: "a capacity above the default",
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
		weakenedBy: "any entry, because a hook can refuse a sign-in the core would have allowed",
	},
	{
		option: "webauthn",
		safeDefault: "no default: the relying party is optional",
		weakenedBy: '"preferred" user verification, which admits an unverified second factor',
	},
	{
		option: "totp",
		safeDefault: "issuer required, tolerance 1 step",
		weakenedBy: "nothing: a tolerance above one step is not applied (A.8, E-1693)",
	},
	{
		option: "recoveryCodes",
		safeDefault: "10 codes in groups of 5",
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

const DEFAULT_ADDRESS_CAPACITY = 10;
const DEFAULT_ACCOUNT_CAPACITY = 5;
const DEFAULT_RECOVERY_CODE_COUNT = 10;

interface FreshnessWindows {
	readonly defaultMs: number;
	readonly chosenMs: number;
}

type ObservedConfig = BaseConfig<IdentityMode> & {
	readonly recoveryCodes?: { readonly count: number };
};

type Detector = (config: ObservedConfig, freshness: FreshnessWindows) => ChosenWeakening | null;

//one detector per option, so a new option adds a row rather than a branch
const DETECTORS: readonly Detector[] = [
	(_config, freshness) =>
		freshness.chosenMs > freshness.defaultMs
			? { option: "session", chosen: `freshnessWindow ${freshness.chosenMs}ms` }
			: null,

	(config) =>
		config.sessionMetadata !== undefined && config.sessionMetadata !== "truncated"
			? { option: "sessionMetadata", chosen: config.sessionMetadata }
			: null,

	(config) =>
		config.trustedProxies !== undefined && config.trustedProxies.length > 0
			? { option: "trustedProxies", chosen: `${config.trustedProxies.length} trusted range(s)` }
			: null,

	(config) => {
		const address = config.rateLimit?.perIpAddress?.capacity ?? DEFAULT_ADDRESS_CAPACITY;
		const account = config.rateLimit?.perAccount?.capacity ?? DEFAULT_ACCOUNT_CAPACITY;
		return address > DEFAULT_ADDRESS_CAPACITY || account > DEFAULT_ACCOUNT_CAPACITY
			? { option: "rateLimit", chosen: `capacity ${address} per address, ${account} per account` }
			: null;
	},

	(config) =>
		config.webauthn !== undefined && config.webauthn.userVerification !== "required"
			? { option: "webauthn", chosen: config.webauthn.userVerification }
			: null,

	(config) => {
		const count = config.recoveryCodes?.count ?? DEFAULT_RECOVERY_CODE_COUNT;
		return count < DEFAULT_RECOVERY_CODE_COUNT
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
		config.plugins !== undefined && config.plugins.length > 0
			? { option: "plugins", chosen: config.plugins.map((plugin) => plugin.id).join(", ") }
			: null,

	(config) =>
		config.clock === undefined ? null : { option: "clock", chosen: "a clock the caller supplied" },
];

//each weakened option appears once, as the operator reads what was given up (S-DEFAULT-1)
export function weakeningsIn<M extends IdentityMode>(
	config: BaseConfig<M> & { readonly recoveryCodes?: { readonly count: number } },
	defaultFreshnessWindowMs: number,
	chosenFreshnessWindowMs: number,
): readonly ChosenWeakening[] {
	const observed = config as ObservedConfig;
	const freshness = { defaultMs: defaultFreshnessWindowMs, chosenMs: chosenFreshnessWindowMs };
	return DETECTORS.map((detect) => detect(observed, freshness)).filter(
		(weakening): weakening is ChosenWeakening => weakening !== null,
	);
}
