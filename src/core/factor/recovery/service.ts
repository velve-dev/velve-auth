import type { Actor } from "../../db/actor.js";
import type { Driver } from "../../db/driver.js";
import { ConcealedError } from "../../http/error-map.js";
import type { KeyProvider } from "../../keys/provider.js";
import type { PendingAuthenticationService, PendingResolution } from "../pending/service.js";
import type { PendingToken } from "../pending/token.js";
import { verifyUnderPendingAttemptLimit } from "../totp/pending-attempt.js";
import { createRecoveryCodeSet } from "./code.js";
import { pepperRecoveryCode, pepperRecoveryCodeUnder } from "./pepper.js";
import { createRecoveryCodeRepository } from "./repository.js";

export interface RecoveryCodeServiceOptions {
	readonly driver: Driver;
	readonly keys: KeyProvider;
	readonly pending: PendingAuthenticationService;
	readonly schema?: string;
}

export interface RecoveryCodeService {
	/** The plaintext codes leave the process here, once; what is stored is their HMAC (B.6). */
	generate(input: { readonly actor: Actor }): Promise<{ readonly codes: readonly string[] }>;
	/** As with TOTP, the resolution is returned and not consumed; the session and the removal of the pending row are one transaction elsewhere (E-410). */
	verify(input: {
		readonly pendingToken: PendingToken;
		readonly code: string;
	}): Promise<PendingResolution>;
	remaining(input: { readonly actor: Actor }): Promise<{ readonly remainingCount: number }>;
}

export function createRecoveryCodeService(
	options: RecoveryCodeServiceOptions,
): RecoveryCodeService {
	const codes = createRecoveryCodeRepository({
		driver: options.driver,
		schema: options.schema ?? "velve",
	});

	/** L-3: a code written under a retired pepper version cannot be recomputed, and that is the one case the lookup has to tell from a wrong code. */
	async function candidateHmacsFor(
		userId: string,
		code: string,
	): Promise<readonly Uint8Array<ArrayBuffer>[]> {
		const versions = await codes.pepperVersionsOf({ userId });
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
		// 3.6: a change of the method regenerates the whole set and deletes the previous one in the same transaction.
		async generate({ actor }) {
			const plaintext = createRecoveryCodeSet();
			const peppered = await Promise.all(
				plaintext.map((code) => pepperRecoveryCode(options.keys, code)),
			);
			await codes.replaceEveryCode({ actor, codes: peppered });
			return { codes: plaintext };
		},

		verify({ pendingToken, code }) {
			return verifyUnderPendingAttemptLimit(options.pending, pendingToken, async (resolution) => {
				const candidates = await candidateHmacsFor(resolution.userId, code);
				if (candidates.length === 0) {
					throw new ConcealedError("recovery_codes_never_generated");
				}
				if (!(await codes.consumeCode({ userId: resolution.userId, candidateHmacs: candidates }))) {
					throw new ConcealedError("recovery_code_not_found");
				}
				return resolution;
			});
		},

		async remaining({ actor }) {
			return { remainingCount: await codes.countCodes({ actor }) };
		},
	};
}
