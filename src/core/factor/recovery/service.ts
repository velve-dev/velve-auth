import type { Actor } from "../../db/actor.js";
import type { Driver } from "../../db/driver.js";
import { ConcealedError } from "../../http/error-map.js";
import { equalsInConstantTime } from "../../keys/constant-time.js";
import type { KeyProvider } from "../../keys/provider.js";
import type { SecurityStateRead } from "../../security-state/read.js";
import {
	issueAuthorisationOf,
	type SecurityStateRuntime,
	sealChange,
} from "../../security-state/runtime.js";
import { componentsAfter, SealingRefusedError } from "../../security-state/sealing.js";
import { verifyUnderPendingAttemptLimit } from "../pending/attempt-limit.js";
import type { PendingAuthenticationService } from "../pending/service.js";
import type { PendingToken } from "../pending/token.js";
import type { CheckedSecondFactor } from "../totp/service.js";
import {
	createRecoveryCodeSet,
	DEFAULT_RECOVERY_CODE_SHAPE,
	type RecoveryCodeShape,
} from "./code.js";
import { pepperRecoveryCode, pepperRecoveryCodeUnder } from "./pepper.js";
import { createRecoveryCodeRepository, RecoveryCodeOwnerUnknownError } from "./repository.js";

export interface RecoveryCodeServiceOptions {
	readonly driver: Driver;
	readonly keys: KeyProvider;
	readonly pending: PendingAuthenticationService;
	readonly schema?: string;
	readonly shape?: RecoveryCodeShape;
	/** the seal a generation reseals and a second factor checks and reseals */
	readonly securityState: SecurityStateRuntime;
}

export interface RecoveryCodeService {
	/** returns the plaintext codes exactly once, and only their HMAC is stored */
	generate(input: { readonly actor: Actor }): Promise<{ readonly codes: readonly string[] }>;
	/** returns the resolution and the seal the spent code left and does not consume the pending state */
	verify(input: {
		readonly pendingToken: PendingToken;
		readonly code: string;
	}): Promise<CheckedSecondFactor>;
	remaining(input: { readonly actor: Actor }): Promise<{ readonly remainingCount: number }>;
}

export function createRecoveryCodeService(
	options: RecoveryCodeServiceOptions,
): RecoveryCodeService {
	const codes = createRecoveryCodeRepository({
		driver: options.driver,
		schema: options.schema ?? "velve",
	});

	//the candidates are taken under the pepper versions the verified read holds (S-INTEG-4)
	async function candidateHmacsFor(
		read: SecurityStateRead,
		code: string,
	): Promise<readonly Uint8Array<ArrayBuffer>[]> {
		const versions = [...new Set(read.recoveryCodes.map((stored) => stored.keyVersion))];
		const candidates: Uint8Array<ArrayBuffer>[] = [];
		for (const version of versions) {
			const peppered = await pepperRecoveryCodeUnder(options.keys, version, code);
			if (peppered !== null) {
				candidates.push(peppered.codeHmac);
			}
		}
		return candidates;
	}

	return {
		//a new set must retire the old one in the same transaction or both would be valid
		async generate({ actor }) {
			const plaintext = createRecoveryCodeSet(options.shape ?? DEFAULT_RECOVERY_CODE_SHAPE);
			const peppered = await Promise.all(
				plaintext.map((code) => pepperRecoveryCode(options.keys, code)),
			);
			await sealChange(
				options.securityState,
				actor,
				{
					epoch: "keep",
					write: (tx) =>
						createRecoveryCodeRepository({
							driver: tx,
							schema: options.schema ?? "velve",
						}).replaceEveryCode({ actor, codes: peppered }),
					after: (read) => componentsAfter(read, { recoveryCodes: peppered }),
				},
				{ accountMissing: () => new RecoveryCodeOwnerUnknownError() },
			);
			return { codes: plaintext };
		},

		//the spent code must be one of the codes the seal covers, and its removal reseals (S-INTEG-4)
		verify({ pendingToken, code }) {
			return verifyUnderPendingAttemptLimit(options.pending, pendingToken, async (resolution) => {
				const sealed = await sealChange(
					options.securityState,
					{ unproven: resolution.userId },
					{
						epoch: "keep",
						write: async (tx, read) => {
							const candidates = await candidateHmacsFor(read, code);
							if (candidates.length === 0) {
								throw new ConcealedError("recovery_codes_never_generated");
							}
							const consumed = await createRecoveryCodeRepository({
								driver: tx,
								schema: options.schema ?? "velve",
							}).consumeCode({ userId: resolution.userId, candidateHmacs: candidates });
							if (consumed === null) {
								throw new ConcealedError("recovery_code_not_found");
							}
							if (
								!read.recoveryCodes.some((stored) =>
									equalsInConstantTime(stored.codeHmac, consumed.codeHmac),
								)
							) {
								throw new SealingRefusedError("seal_mismatch");
							}
							return consumed.codeHmac;
						},
						after: (read, spent) => {
							let removed = false;
							return componentsAfter(read, {
								recoveryCodes: read.recoveryCodes.filter((stored) => {
									if (!removed && equalsInConstantTime(stored.codeHmac, spent)) {
										removed = true;
										return false;
									}
									return true;
								}),
							});
						},
					},
					{ occasion: "factor_check", refusal: "broken_state_on_recovery_second_factor" },
				);
				return {
					resolution,
					authorisedBy: issueAuthorisationOf(sealed),
				};
			});
		},

		async remaining({ actor }) {
			return { remainingCount: await codes.countCodes({ actor }) };
		},
	};
}
