import { VelveError } from "../http/error-map.js";
import type { SecurityStateRead } from "./read.js";

/** how many passkeys and identities one account may hold, which bounds what every seal check reads */
export interface LimitsConfig {
	readonly passkeysPerAccount: number;
	readonly identitiesPerAccount: number;
}

export const DEFAULT_LIMITS: LimitsConfig = { passkeysPerAccount: 20, identitiesPerAccount: 10 };

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
		throw new VelveError("passkey_limit_reached");
	}
	if (credential === "identity" && read.identities.length >= limits.identitiesPerAccount) {
		throw new VelveError("identity_limit_reached");
	}
}
