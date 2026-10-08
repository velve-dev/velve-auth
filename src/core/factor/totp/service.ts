import { type SealingMode, unboundReadingOf } from "../../auth/security-state.js";
import type { Actor } from "../../db/actor.js";
import type { Driver } from "../../db/driver.js";
import type { Clock } from "../../http/environment.js";
import { ConcealedError, VelveError } from "../../http/error-map.js";
import { decryptBound, type EnvelopeBinding, encryptBound } from "../../keys/envelope-binding.js";
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
	/** the sealing mode the unbound form is read under, `"required"` when absent */
	readonly sealing?: SealingMode;
}

//the owner names the row as the table holds one row per account and no id of its own (S-INTEG-1)
function secretBindingOf(userId: string): EnvelopeBinding {
	return { column: "totp_credential.secret_enc", owner: userId, row: userId };
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
	const sealing = options.sealing ?? "required";

	//an unreadable secret answers as a factor nobody can hold (E-428)
	async function decryptSecret(
		owner: string,
		credential: StoredTotpCredential,
	): Promise<Uint8Array<ArrayBuffer>> {
		try {
			return await decryptBound(
				options.keys,
				secretBindingOf(owner),
				{ keyVersion: credential.keyVersion, ciphertext: credential.secretEnc },
				unboundReadingOf(sealing, credential.sealRow),
			);
		} catch (failure) {
			throw failure instanceof KeyError ? new ConcealedError("totp_not_confirmed") : failure;
		}
	}

	//an absent factor and one not held answer alike
	async function matchConfirmedCode(input: {
		readonly owner: string;
		readonly credential: StoredTotpCredential | null;
		readonly code: string;
	}): Promise<number> {
		if (input.credential === null || input.credential.confirmedAt === null) {
			throw new ConcealedError("totp_not_confirmed");
		}
		const step = matchingTimeStep({
			secretBytes: await decryptSecret(input.owner, input.credential),
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

	//a secret replaced by a concurrent start was never proved so the code counts as wrong
	async function refuseAnUnconfirmedEnrolment(actor: Actor): Promise<never> {
		const current = await credentials.findCredential({ actor });
		if (current !== null && current.confirmedAt !== null) {
			throw new VelveError("factor_already_enrolled");
		}
		throw new ConcealedError("totp_code_wrong");
	}

	return {
		enroll: {
			async start({ actor, accountName }) {
				const secretBytes = createTotpSecret();
				const { keyVersion, ciphertext } = await encryptBound(
					options.keys,
					secretBindingOf(actor),
					secretBytes,
				);
				const written = await credentials.putUnconfirmedCredential({
					actor,
					secretEnc: ciphertext,
					keyVersion,
				});
				if (!written) {
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
					secretBytes: await decryptSecret(actor, credential),
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
				if (!(await credentials.confirmCredential({ actor, secretEnc: credential.secretEnc }))) {
					await refuseAnUnconfirmedEnrolment(actor);
				}
			},
		},

		verify({ pendingToken, code }) {
			return verifyUnderPendingAttemptLimit(options.pending, pendingToken, async (resolution) => {
				const step = await matchConfirmedCode({
					owner: resolution.userId,
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
			const step = await matchConfirmedCode({ owner: actor, credential, code });
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
