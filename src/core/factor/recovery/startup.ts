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

/** S-DEFAULT-4: the mode with no e-mail on the account has no other way back in, so leaving the codes off is a start error and not a warning. */
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
