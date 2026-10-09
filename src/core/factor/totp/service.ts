import { type SealRowPresence, unboundReadingOf } from "../../auth/security-state.js";
import type { Actor } from "../../db/actor.js";
import type { Driver } from "../../db/driver.js";
import type { IssueAuthorisation } from "../../db/repositories/session.js";
import type { Clock } from "../../http/environment.js";
import { ConcealedError, VelveError } from "../../http/error-map.js";
import { decryptBound, type EnvelopeBinding, encryptBound } from "../../keys/envelope-binding.js";
import { KeyError } from "../../keys/errors.js";
import type { KeyProvider } from "../../keys/provider.js";
import type { SecurityStateRead } from "../../security-state/read.js";
import {
	checkAccount,
	type SecurityStateRuntime,
	sealChange,
} from "../../security-state/runtime.js";
import { componentsAfter } from "../../security-state/sealing.js";
import { verifyUnderPendingAttemptLimit } from "../pending/attempt-limit.js";
import type { PendingAuthenticationService, PendingResolution } from "../pending/service.js";
import type { PendingToken } from "../pending/token.js";
import { matchingTimeStep } from "./code.js";
import {
	TOTP_TOLERANCE_STEPS,
	type TotpToleranceInSteps,
	usedStepRetentionSeconds,
} from "./parameters.js";
import { createTotpRepository } from "./repository.js";
import { createTotpSecret, type TotpEnrollment, totpEnrollment } from "./secret.js";

export interface TotpServiceOptions {
	readonly driver: Driver;
	readonly keys: KeyProvider;
	readonly pending: PendingAuthenticationService;
	readonly issuer: string;
	readonly clock: Clock;
	readonly schema?: string;
	readonly toleranceInSteps?: TotpToleranceInSteps;
	/** the seal every enrolment, check and removal verifies and writes */
	readonly securityState: SecurityStateRuntime;
}

/** a TOTP secret as a verified read holds it */
interface HeldSecret {
	readonly secretEnc: Uint8Array<ArrayBuffer>;
	readonly keyVersion: number;
	readonly confirmed: boolean;
	readonly sealRow: SealRowPresence;
}

function heldSecretOf(read: SecurityStateRead): HeldSecret | null {
	return read.totp === null
		? null
		: {
				secretEnc: read.totp.secretEnc,
				keyVersion: read.totp.keyVersion,
				confirmed: read.totp.confirmed,
				sealRow: read.seal === null ? "absent" : "present",
			};
}

/** a second factor the check verified, with the seal it read for the session it completes */
export interface CheckedSecondFactor {
	readonly resolution: PendingResolution;
	readonly authorisedBy: IssueAuthorisation;
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
	/** returns the resolution and the seal it checked and does not consume the pending state */
	verify(input: {
		readonly pendingToken: PendingToken;
		readonly code: string;
	}): Promise<CheckedSecondFactor>;
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
	const { securityState } = options;
	const sealing = securityState.sealing;

	//an unreadable secret answers as a factor nobody can hold (E-428)
	async function decryptSecret(
		owner: string,
		credential: HeldSecret,
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
		readonly credential: HeldSecret | null;
		readonly code: string;
	}): Promise<number> {
		if (input.credential === null || !input.credential.confirmed) {
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

	function totpAfter(read: SecurityStateRead, totp: SecurityStateRead["totp"]) {
		return componentsAfter(read, { totp });
	}

	return {
		enroll: {
			//even an unconfirmed secret is written under the account lock and sealed (E-3385)
			async start({ actor, accountName }) {
				const secretBytes = createTotpSecret();
				const { keyVersion, ciphertext } = await encryptBound(
					options.keys,
					secretBindingOf(actor),
					secretBytes,
				);
				await sealChange(securityState, actor, {
					epoch: "keep",
					write: async (tx) => {
						const written = await createTotpRepository({
							driver: tx,
							schema: options.schema ?? "velve",
						}).putUnconfirmedCredential({ actor, secretEnc: ciphertext, keyVersion });
						if (!written) {
							throw new VelveError("factor_already_enrolled");
						}
					},
					after: (read) => totpAfter(read, { secretEnc: ciphertext, keyVersion, confirmed: false }),
				});
				return totpEnrollment({ secretBytes, issuer: options.issuer, accountName });
			},

			//the code proves the app holds the secret before the factor guards the account
			async finish({ actor, code }) {
				await sealChange(securityState, actor, {
					epoch: "keep",
					write: async (tx, read) => {
						const credential = heldSecretOf(read);
						if (credential === null) {
							throw new VelveError("factor_not_enrolled");
						}
						if (credential.confirmed) {
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
						const repository = createTotpRepository({
							driver: tx,
							schema: options.schema ?? "velve",
						});
						rejectAReplayedStep(
							await repository.claimTimeStep({ actor, timeStep: step, retentionSeconds }),
						);
						if (!(await repository.confirmCredential({ actor, secretEnc: credential.secretEnc }))) {
							await refuseAnUnconfirmedEnrolment(actor);
						}
						return credential;
					},
					after: (read, credential) =>
						totpAfter(read, {
							secretEnc: credential.secretEnc,
							keyVersion: credential.keyVersion,
							confirmed: true,
						}),
				});
			},
		},

		//the secret the code is matched against comes from the read the seal check verified (S-INTEG-4)
		verify({ pendingToken, code }) {
			return verifyUnderPendingAttemptLimit(options.pending, pendingToken, async (resolution) => {
				const check = await checkAccount(securityState, resolution.userId, "factor_check");
				if (check.kind !== "usable") {
					throw new ConcealedError("broken_state_on_totp_second_factor");
				}
				const step = await matchConfirmedCode({
					owner: resolution.userId,
					credential: heldSecretOf(check.read),
					code,
				});
				rejectAReplayedStep(
					await credentials.claimTimeStepOfPending({
						pending: resolution,
						timeStep: step,
						retentionSeconds,
					}),
				);
				return { resolution, authorisedBy: check.authorisedBy };
			});
		},

		//removing the factor must require holding it
		async remove({ actor, code }) {
			await sealChange(securityState, actor, {
				epoch: "keep",
				write: async (tx, read) => {
					const credential = heldSecretOf(read);
					if (credential === null || !credential.confirmed) {
						throw new VelveError("factor_not_enrolled");
					}
					const step = await matchConfirmedCode({ owner: actor, credential, code });
					const repository = createTotpRepository({
						driver: tx,
						schema: options.schema ?? "velve",
					});
					rejectAReplayedStep(
						await repository.claimTimeStep({ actor, timeStep: step, retentionSeconds }),
					);
					if (!(await repository.removeCredential({ actor }))) {
						throw new VelveError("factor_not_enrolled");
					}
				},
				after: (read) => totpAfter(read, null),
			});
		},

		isEnrolled: ({ userId }) => credentials.isConfirmedFor({ userId }),
	};
}
