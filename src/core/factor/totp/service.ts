import type { Actor } from "../../db/actor.js";
import type { Driver } from "../../db/driver.js";
import type { Clock } from "../../http/environment.js";
import { ConcealedError, VelveError } from "../../http/error-map.js";
import { decryptWithPurposeKey, encryptWithPurposeKey } from "../../keys/envelope.js";
import { KeyError } from "../../keys/errors.js";
import type { KeyProvider } from "../../keys/provider.js";
import { verifyUnderPendingAttemptLimit } from "../pending/attempt-limit.js";
import type { PendingAuthenticationService, PendingResolution } from "../pending/service.js";
import type { PendingToken } from "../pending/token.js";
import { matchingTimeStep } from "./code.js";
import {
	TOTP_TOLERANCE_STEPS,
	type TotpToleranceInSteps,
	usedStepRetentionSeconds,
} from "./parameters.js";
import { createTotpRepository, type StoredTotpCredential } from "./repository.js";
import { createTotpSecret, type TotpEnrollment, totpEnrollment } from "./secret.js";

export interface TotpServiceOptions {
	readonly driver: Driver;
	readonly keys: KeyProvider;
	readonly pending: PendingAuthenticationService;
	readonly issuer: string;
	readonly clock: Clock;
	readonly schema?: string;
	/** A.8: how far either side of the current step a code is still accepted. Default 1. */
	readonly toleranceInSteps?: TotpToleranceInSteps;
}

export interface TotpService {
	enroll: {
		start(input: { readonly actor: Actor; readonly accountName: string }): Promise<TotpEnrollment>;
		finish(input: { readonly actor: Actor; readonly code: string }): Promise<void>;
	};
	/** The resolution is returned rather than consumed: S-FIX-1 wants the pending row removed in the same transaction that inserts the session, and that transaction belongs to whoever issues the session (E-410). */
	verify(input: {
		readonly pendingToken: PendingToken;
		readonly code: string;
	}): Promise<PendingResolution>;
	remove(input: { readonly actor: Actor; readonly code: string }): Promise<void>;
	isEnrolled(input: { readonly userId: string }): Promise<boolean>;
}

export function createTotpService(options: TotpServiceOptions): TotpService {
	const credentials = createTotpRepository({
		driver: options.driver,
		schema: options.schema ?? "velve",
	});
	const toleranceInSteps = options.toleranceInSteps ?? TOTP_TOLERANCE_STEPS;
	const retentionSeconds = usedStepRetentionSeconds(toleranceInSteps);

	/**
	 * S-REST-4 and S-KEY-3: the secret is the one value here the server needs back in the clear.
	 * A `KeyError` is neither a `VelveError` nor a `ConcealedError`, so letting it out answers 500 on
	 * three routes that declare no such status, and makes an account whose secret predates a rotation
	 * distinguishable from every other one. A secret the server cannot read is a factor nobody can
	 * hold, which is the class `totp_not_confirmed` already names (E-428).
	 */
	async function decryptSecret(credential: StoredTotpCredential): Promise<Uint8Array<ArrayBuffer>> {
		try {
			return await decryptWithPurposeKey(
				options.keys,
				"totp-enc",
				credential.keyVersion,
				credential.secretEnc,
			);
		} catch (failure) {
			throw failure instanceof KeyError ? new ConcealedError("totp_not_confirmed") : failure;
		}
	}

	/** A factor that is absent and one that is not held answer alike, because the route that verifies is reached with a pending state and not with a session. */
	async function matchConfirmedCode(input: {
		readonly credential: StoredTotpCredential | null;
		readonly code: string;
	}): Promise<number> {
		if (input.credential === null || input.credential.confirmedAt === null) {
			throw new ConcealedError("totp_not_confirmed");
		}
		const step = matchingTimeStep({
			secretBytes: await decryptSecret(input.credential),
			submittedCode: input.code,
			at: options.clock.now(),
			toleranceInSteps,
		});
		if (step === null) {
			throw new ConcealedError("totp_code_wrong");
		}
		return step;
	}

	/** S-REPLAY-4: the step that matched is what the guard records, so a code from the tolerance window cannot be replayed under the current step's key. */
	async function claimOrReject(userId: string, timeStep: number): Promise<void> {
		const claimed = await credentials.claimTimeStep({
			userId,
			timeStep,
			retentionSeconds,
		});
		if (!claimed) {
			throw new ConcealedError("totp_step_replayed");
		}
	}

	return {
		enroll: {
			async start({ actor, accountName }) {
				const secretBytes = createTotpSecret();
				const { keyVersion, ciphertext } = await encryptWithPurposeKey(
					options.keys,
					"totp-enc",
					secretBytes,
				);
				const written = await credentials.putUnconfirmedCredential({
					actor,
					secretEnc: ciphertext,
					keyVersion,
				});
				if (written === null) {
					throw new VelveError("factor_already_enrolled");
				}
				return totpEnrollment({ secretBytes, issuer: options.issuer, accountName });
			},

			// The code proves the app holds the secret before the factor starts guarding the account.
			async finish({ actor, code }) {
				const credential = await credentials.findCredential({ actor });
				if (credential === null) {
					throw new VelveError("factor_not_enrolled");
				}
				if (credential.confirmedAt !== null) {
					throw new VelveError("factor_already_enrolled");
				}
				const step = matchingTimeStep({
					secretBytes: await decryptSecret(credential),
					submittedCode: code,
					at: options.clock.now(),
					toleranceInSteps,
				});
				if (step === null) {
					throw new ConcealedError("totp_code_wrong");
				}
				await claimOrReject(actor, step);
				if (!(await credentials.confirmCredential({ actor }))) {
					throw new VelveError("factor_already_enrolled");
				}
			},
		},

		verify({ pendingToken, code }) {
			return verifyUnderPendingAttemptLimit(options.pending, pendingToken, async (resolution) => {
				const step = await matchConfirmedCode({
					credential: await credentials.findCredentialOf({ userId: resolution.userId }),
					code,
				});
				await claimOrReject(resolution.userId, step);
				return resolution;
			});
		},

		// B.6: whoever can remove the factor without holding it has no factor.
		async remove({ actor, code }) {
			const credential = await credentials.findCredential({ actor });
			if (credential === null || credential.confirmedAt === null) {
				throw new VelveError("factor_not_enrolled");
			}
			const step = await matchConfirmedCode({ credential, code });
			await claimOrReject(actor, step);
			if (!(await credentials.removeCredential({ actor }))) {
				throw new VelveError("factor_not_enrolled");
			}
		},

		async isEnrolled({ userId }) {
			const credential = await credentials.findCredentialOf({ userId });
			return credential !== null && credential.confirmedAt !== null;
		},
	};
}
