import type { IdentityMode } from "../../db/migrations/identity-mode.js";

export class RecoveryCodesRequiredError extends Error {
	readonly code = "recovery_codes_required";

	constructor(identityMode: IdentityMode) {
		super(
			`identity: "${identityMode}" requires recoveryCodes: true, because a username account has no address a reset can be sent to.`,
		);
		this.name = "RecoveryCodesRequiredError";
	}
}

//username mode without recovery codes has no way back in (S-DEFAULT-4)
export function recoveryCodesAreMandatoryFor(identityMode: IdentityMode): boolean {
	return identityMode === "username";
}

export function assertRecoveryCodesAreConfigured(configuration: {
	readonly identityMode: IdentityMode;
	readonly recoveryCodes: boolean;
}): void {
	if (recoveryCodesAreMandatoryFor(configuration.identityMode) && !configuration.recoveryCodes) {
		throw new RecoveryCodesRequiredError(configuration.identityMode);
	}
}
