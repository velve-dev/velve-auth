/** what the waiting period of one recovery to a new passkey is asked with */
export interface PasskeyRecoveryContext {
	readonly userId: string;
}

/** turns the recovery to a new passkey on and says how long its new passkey waits before it signs in */
export interface PasskeyRecoveryConfig {
	/** seconds from the registration of the new passkey until it replaces every other way in, read on that request */
	readonly waitingPeriodInSeconds: (context: PasskeyRecoveryContext) => number;
}

const SECONDS_IN_A_DAY = 24 * 60 * 60;

/** the longest waiting period the library holds a new passkey back for */
export const LONGEST_PASSKEY_RECOVERY_WAIT_IN_SECONDS = 30 * SECONDS_IN_A_DAY;

//an answer outside the bounds is clamped and an answer that is no number waits the longest (E-3764)
export function waitingPeriodWithinBounds(answer: unknown): number {
	if (typeof answer !== "number" || Number.isNaN(answer)) {
		return LONGEST_PASSKEY_RECOVERY_WAIT_IN_SECONDS;
	}
	return Math.min(Math.max(Math.ceil(answer), 0), LONGEST_PASSKEY_RECOVERY_WAIT_IN_SECONDS);
}

/** whether a configuration value can turn the recovery on, checked at the start */
export function isUsablePasskeyRecoveryConfig(configured: unknown): boolean {
	return (
		typeof configured === "object" &&
		configured !== null &&
		typeof (configured as { waitingPeriodInSeconds?: unknown }).waitingPeriodInSeconds ===
			"function"
	);
}
