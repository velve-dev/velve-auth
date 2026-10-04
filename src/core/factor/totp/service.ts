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
	readonly toleranceInSteps?: TotpToleranceInSteps;
}

export interface TotpService {
	enroll: {
		start(input: { readonly actor: Actor; readonly accountName: string }): Promise<TotpEnrollment>;
		finish(input: { readonly actor: Actor; readonly code: string }): Promise<void>;
	};
	/** returns the resolution and does not consume the pending state */
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

	//an unreadable secret answers as a factor nobody can hold (E-428)
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

	//an absent factor and one not held answer alike
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

	//the matched step is recorded so a window code cannot be replayed (S-REPLAY-4)
	function rejectAReplayedStep(claimed: boolean): void {
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

			//the code proves the app holds the secret before the factor guards the account
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
				rejectAReplayedStep(
					await credentials.claimTimeStep({ actor, timeStep: step, retentionSeconds }),
				);
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
				rejectAReplayedStep(
					await credentials.claimTimeStepOfPending({
						pending: resolution,
						timeStep: step,
						retentionSeconds,
					}),
				);
				return resolution;
			});
		},

		//removing the factor must require holding it
		async remove({ actor, code }) {
			const credential = await credentials.findCredential({ actor });
			if (credential === null || credential.confirmedAt === null) {
				throw new VelveError("factor_not_enrolled");
			}
			const step = await matchConfirmedCode({ credential, code });
			rejectAReplayedStep(
				await credentials.claimTimeStep({ actor, timeStep: step, retentionSeconds }),
			);
			if (!(await credentials.removeCredential({ actor }))) {
				throw new VelveError("factor_not_enrolled");
			}
		},

		isEnrolled: ({ userId }) => credentials.isConfirmedFor({ userId }),
	};
}
