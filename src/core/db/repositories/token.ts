import {
	ONE_TIME_TOKEN_LIFETIME_SECONDS,
	ONE_TIME_TOKEN_PURPOSES,
	type OneTimeTokenPayload,
	type OneTimeTokenPurpose,
} from "../../token/purpose.js";
import type { RedeemedOneTimeToken } from "../actor.js";
import type { Driver } from "../driver.js";
import { toEntityId } from "../entity-id.js";
import { assertSchemaName, qualifiedTableName } from "../identifier.js";

export interface OneTimeTokenRepositoryOptions {
	readonly driver: Driver;
	readonly schema: string;
}

export interface OneTimeTokenReplacement {
	readonly tokenSha256: Uint8Array;
	readonly purpose: OneTimeTokenPurpose;
	/**
	 * `null` writes the cover row S-TIM-6 needs: an address that names no account must cost the
	 * same statements as one that does, and S-TOKEN-4 already answers such a row as no row (E-597).
	 */
	readonly userId: string | null;
	readonly payload: OneTimeTokenPayload | null;
}

export interface OneTimeTokenLookup {
	readonly tokenSha256: Uint8Array;
	readonly purpose: OneTimeTokenPurpose;
}

/** E-234: the removal proved the owner, so what comes back is the second lawful provenance of an `Actor`. */
export type StoredOneTimeToken = RedeemedOneTimeToken & {
	readonly payload: OneTimeTokenPayload | null;
};

export interface OneTimeTokenRepository {
	replaceOneTimeToken(input: OneTimeTokenReplacement): Promise<{ expiresAt: string }>;
	/** S-TOKEN-4: a row that names no account is answered exactly as no row is. */
	consumeOneTimeToken(input: OneTimeTokenLookup): Promise<StoredOneTimeToken | null>;
}

export type OneTimeTokenErrorCode =
	| "one_time_token_owner_unknown"
	| "one_time_token_purpose_unknown"
	| "one_time_token_not_written";

// Fixed per code, so nothing the caller passed can reach an error string.
const MESSAGE_BY_ERROR_CODE: Readonly<Record<OneTimeTokenErrorCode, string>> = {
	one_time_token_owner_unknown: "The account the token would belong to does not exist.",
	one_time_token_purpose_unknown: "The purpose is not one of the four one-time token purposes.",
	one_time_token_not_written: "The insert reported no row.",
};

export class OneTimeTokenError extends Error {
	readonly code: OneTimeTokenErrorCode;

	/** E-265: what the failure was about travels in its own field, never spliced into the
	 * message. It is null for the one code that fires because the purpose is not a purpose. */
	readonly purpose: OneTimeTokenPurpose | null;

	constructor(code: OneTimeTokenErrorCode, purpose: OneTimeTokenPurpose | null) {
		super(MESSAGE_BY_ERROR_CODE[code]);
		this.name = "OneTimeTokenError";
		this.code = code;
		this.purpose = purpose;
	}
}

/**
 * The cover row of E-597 is written by the statements a named owner is written by, so it needs an
 * account identifier for the lock and the supersession that no account can answer to. Drawn afresh
 * each time rather than fixed, because a fixed one names a row an import could create.
 */
function anAccountThatCannotExist(): string {
	return crypto.randomUUID();
}

const EXPIRY_AS_ISO_8601 = `to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// E-93: the one place in this repository where the redemption becomes evidence of an owner.
function redeemedBy(userId: string, payload: OneTimeTokenPayload | null): StoredOneTimeToken {
	return { userId: toEntityId<"user">(userId), payload } as StoredOneTimeToken;
}

/** A driver may hand back `jsonb` decoded or as the text PostgreSQL sent; both arrive here. */
function readPayload(value: unknown): OneTimeTokenPayload | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === "string") {
		return JSON.parse(value) as OneTimeTokenPayload;
	}
	return value as OneTimeTokenPayload;
}

export function createOneTimeTokenRepository(
	options: OneTimeTokenRepositoryOptions,
): OneTimeTokenRepository {
	const schema = assertSchemaName(options.schema);
	const table = qualifiedTableName(schema, "one_time_token");

	// S-TOKEN-3: the statement below is atomic, but at READ COMMITTED its DELETE works from the
	// snapshot the statement began with and therefore cannot remove a row a concurrent request
	// inserted after it. Serialising the requests of one user is what makes the replacement hold
	// under concurrency; the lock is taken before the snapshot that matters.
	const lockOwnerStatement = `SELECT 1 FROM ${schema}.user
WHERE id = $1 FOR UPDATE /* locks: ${schema}.user */`;

	const replaceStatement = `WITH superseded AS (
	DELETE FROM ${table} WHERE user_id = $1 AND purpose = $2
)
INSERT INTO ${table} (token_sha256, purpose, user_id, payload, expires_at)
VALUES ($3, $2, $6, $4, now() + make_interval(secs => $5::double precision))
RETURNING ${EXPIRY_AS_ISO_8601} AS expires_at`;

	// Section 3.7 word for word apart from the marker E-142 requires: the only way a token is read.
	const consumeStatement = `DELETE FROM ${table}
/* no owner predicate: S-TOKEN-4 */
WHERE token_sha256 = $1 AND purpose = $2 AND expires_at > now()
RETURNING user_id, payload`;

	return {
		async replaceOneTimeToken({ tokenSha256, purpose, userId, payload }) {
			// Without this guard the not-null constraint on expires_at raises instead, and a
			// driver's error names the table and the constraint (E-263). The type rules the case
			// out; a caller that is not type-checked does not.
			if (!ONE_TIME_TOKEN_PURPOSES.includes(purpose)) {
				throw new OneTimeTokenError("one_time_token_purpose_unknown", null);
			}
			const lookupId = userId ?? anAccountThatCannotExist();
			return options.driver.transaction(async (tx) => {
				const owner = await tx.query(lockOwnerStatement, [lookupId]);
				// The account can be deleted between whatever resolved it and this call; the lock
				// has already read the row, so the foreign key never has to report it (E-263).
				if (owner.length === 0 && userId !== null) {
					throw new OneTimeTokenError("one_time_token_owner_unknown", purpose);
				}
				const [row] = await tx.query<{ expires_at: string }>(replaceStatement, [
					lookupId,
					purpose,
					tokenSha256,
					payload === null ? null : JSON.stringify(payload),
					ONE_TIME_TOKEN_LIFETIME_SECONDS[purpose],
					userId,
				]);
				if (row === undefined) {
					throw new OneTimeTokenError("one_time_token_not_written", purpose);
				}
				return { expiresAt: row.expires_at };
			});
		},

		async consumeOneTimeToken({ tokenSha256, purpose }) {
			const [row] = await options.driver.query<{ user_id: string | null; payload: unknown }>(
				consumeStatement,
				[tokenSha256, purpose],
			);
			return row === undefined || row.user_id === null
				? null
				: redeemedBy(row.user_id, readPayload(row.payload));
		},
	};
}
