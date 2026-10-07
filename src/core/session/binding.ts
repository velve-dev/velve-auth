import type { KeyProvider } from "../keys/provider.js";
import {
	checkTokenBinding,
	reportRefusedTokenRow,
	type StoredTokenMac,
	type TokenBinding,
	type TokenBindingRefusalReport,
} from "../token/binding.js";

/** a session row as stored, with the account's current epoch beside it */
interface StoredSessionRow extends StoredTokenMac {
	readonly userId: string;
	readonly tokenHash: Uint8Array;
	/** the factor names exactly as stored, or null where the column holds something that is no name */
	readonly storedFactorNames: readonly string[] | null;
	/** null for an account that has no epoch to be checked against */
	readonly sessionEpoch: number | null;
	readonly createdAtMicros: number;
}

/** what a session's MAC binds beside its owner, token and factors */
export interface SessionIssue {
	readonly sessionEpoch: number;
	/** `created_at` in whole microseconds since the Unix epoch */
	readonly createdAtMicros: number;
}

//a row written back after a mass revocation must stay refused (S-INTEG-9)
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
		content: { factors, sessionEpoch: issue.sessionEpoch, createdAtMicros: issue.createdAtMicros },
	};
}

//an account without an epoch is refused by the seal check and its sessions count as none
export async function isLibrarySessionRow(
	keys: KeyProvider,
	row: StoredSessionRow,
	report: TokenBindingRefusalReport | undefined,
): Promise<boolean> {
	if (row.sessionEpoch === null) {
		return false;
	}
	const binding = sessionBinding(row.userId, row.tokenHash, row.storedFactorNames ?? [], {
		sessionEpoch: row.sessionEpoch,
		createdAtMicros: row.createdAtMicros,
	});
	const verdict =
		row.storedFactorNames === null ? "mismatch" : await checkTokenBinding(keys, binding, row);
	if (verdict !== "valid") {
		reportRefusedTokenRow(report, { userId: row.userId, occasion: "session_resolve", verdict });
	}
	return verdict === "valid";
}
