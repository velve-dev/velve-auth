import type { SecurityStateRead } from "./read.js";

/** how many passkeys and identities one account may hold, which bounds what every seal check reads */
export interface LimitsConfig {
	readonly passkeysPerAccount: number;
	readonly identitiesPerAccount: number;
}

/** the stable code a registration or a link over the account's limit is refused with */
type CredentialLimitCode = "passkey_limit_reached" | "identity_limit_reached";

/** a registration or a link would take the account past its limit, and the change is rolled back */
export class CredentialLimitReachedError extends Error {
	readonly code: CredentialLimitCode;

	constructor(code: CredentialLimitCode) {
		super(`the account already holds as many as its limit allows: ${code}`);
		this.name = "CredentialLimitReachedError";
		this.code = code;
	}
}

const DEFAULT_LIMITS: LimitsConfig = { passkeysPerAccount: 20, identitiesPerAccount: 10 };

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

//a limit that is no count of at least one would refuse every registration or none (S-INTEG-10)
export function resolveLimits(configured: Partial<LimitsConfig> | undefined): LimitsConfig | null {
	const resolved = { ...DEFAULT_LIMITS, ...configured };
	return isCount(resolved.passkeysPerAccount) && isCount(resolved.identitiesPerAccount)
		? resolved
		: null;
}

//the count must come from the read the account lock protects (S-INTEG-10)
export function assertBelowCredentialLimit(
	read: SecurityStateRead,
	credential: "passkey" | "identity",
	limits: LimitsConfig,
): void {
	if (credential === "passkey" && read.passkeys.length >= limits.passkeysPerAccount) {
		throw new CredentialLimitReachedError("passkey_limit_reached");
	}
	if (credential === "identity" && read.identities.length >= limits.identitiesPerAccount) {
		throw new CredentialLimitReachedError("identity_limit_reached");
	}
}
