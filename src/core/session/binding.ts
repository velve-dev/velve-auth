import type { KeyProvider } from "../keys/provider.js";
import {
	checkTokenBinding,
	reportRefusedTokenRow,
	type StoredTokenMac,
	type TokenBinding,
	type TokenBindingOccasion,
	type TokenBindingRefusalReport,
} from "../token/binding.js";

/** a session row as stored, with the account's current epoch beside it */
interface StoredSessionRow extends StoredTokenMac {
	readonly sessionId: string;
	readonly userId: string;
	readonly tokenHash: Uint8Array;
	/** the factor names exactly as stored, or null where the column holds something that is no name */
	readonly storedFactorNames: readonly string[] | null;
	/** null for an account that has no epoch to be checked against */
	readonly sessionEpoch: number | null;
	/** null where the stored creation time is no exact count of microseconds the library could have bound */
	readonly createdAtMicros: number | null;
}

/** what a session's MAC binds beside its owner, token and factors */
export interface SessionIssue {
	/** the row's `id`, drawn before the insert so the MAC can bind it */
	readonly sessionId: string;
	readonly sessionEpoch: number;
	/** `created_at` in whole microseconds since the Unix epoch */
	readonly createdAtMicros: number;
}

//a row written back after a mass revocation or renamed to another id must stay refused (S-INTEG-9)
export function sessionBinding(
	userId: string,
	tokenHash: Uint8Array,
	factors: readonly string[],
	issue: SessionIssue,
): TokenBinding {
	return {
		purpose: "session",
		ownerId: userId,
		tokenSha256: tokenHash,
		content: {
			sessionId: issue.sessionId,
			factors,
			sessionEpoch: issue.sessionEpoch,
			createdAtMicros: issue.createdAtMicros,
		},
	};
}

//an account without an epoch is refused by the seal check and its sessions count as none
export async function librarySessionBinding(
	keys: KeyProvider,
	row: StoredSessionRow,
	refused: {
		readonly report: TokenBindingRefusalReport | undefined;
		readonly occasion: TokenBindingOccasion;
	},
): Promise<TokenBinding | null> {
	if (row.sessionEpoch === null) {
		return null;
	}
	const binding =
		row.storedFactorNames === null || row.createdAtMicros === null
			? null
			: sessionBinding(row.userId, row.tokenHash, row.storedFactorNames, {
					sessionId: row.sessionId,
					sessionEpoch: row.sessionEpoch,
					createdAtMicros: row.createdAtMicros,
				});
	const verdict = binding === null ? "mismatch" : await checkTokenBinding(keys, binding, row);
	if (verdict !== "valid") {
		reportRefusedTokenRow(refused.report, {
			userId: row.userId,
			occasion: refused.occasion,
			verdict,
		});
		return null;
	}
	return binding;
}
