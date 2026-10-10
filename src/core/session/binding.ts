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
	/** the account's current session generation, null for an account that has none to be checked against */
	readonly sessionGeneration: number | null;
	/** null where a stored deadline is no finite count of microseconds the library could have bound */
	readonly idleExpiresAtMicros: string | null;
	readonly absoluteExpiresAtMicros: string | null;
}

/** what a session's MAC binds beside its owner, token and factors */
export interface SessionIssue {
	/** the row's `id`, drawn before the insert so the MAC can bind it */
	readonly sessionId: string;
	readonly sessionEpoch: number;
	/** `created_at` in whole microseconds since the Unix epoch */
	readonly createdAtMicros: number;
	readonly sessionGeneration: number;
	/** `idle_expires_at` in whole microseconds since the Unix epoch, as decimal digits */
	readonly idleExpiresAtMicros: string;
	/** `absolute_expires_at` in whole microseconds since the Unix epoch, as decimal digits */
	readonly absoluteExpiresAtMicros: string;
}

//a row written back after a revocation of its own or of all, renamed or given a later deadline must stay refused (S-INTEG-9)
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
			sessionGeneration: issue.sessionGeneration,
			idleExpiresAtMicros: issue.idleExpiresAtMicros,
			absoluteExpiresAtMicros: issue.absoluteExpiresAtMicros,
		},
	};
}

/** the issue a stored row describes, or null where a column holds what the library never binds */
function issueOfStoredRow(row: StoredSessionRow, sessionEpoch: number): SessionIssue | null {
	if (
		row.createdAtMicros === null ||
		row.sessionGeneration === null ||
		row.idleExpiresAtMicros === null ||
		row.absoluteExpiresAtMicros === null
	) {
		return null;
	}
	return {
		sessionId: row.sessionId,
		sessionEpoch,
		createdAtMicros: row.createdAtMicros,
		sessionGeneration: row.sessionGeneration,
		idleExpiresAtMicros: row.idleExpiresAtMicros,
		absoluteExpiresAtMicros: row.absoluteExpiresAtMicros,
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
	const issue = issueOfStoredRow(row, row.sessionEpoch);
	const binding =
		row.storedFactorNames === null || issue === null
			? null
			: sessionBinding(row.userId, row.tokenHash, row.storedFactorNames, issue);
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
