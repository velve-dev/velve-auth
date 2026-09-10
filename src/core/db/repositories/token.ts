import {
	ONE_TIME_TOKEN_LIFETIME_SECONDS,
	ONE_TIME_TOKEN_PURPOSES,
	type OneTimeTokenPayload,
	type OneTimeTokenPurpose,
	type OneTimeTokenSubject,
} from "../../token/purpose.js";
import type { RedeemedOneTimeToken } from "../actor.js";
import type { Driver } from "../driver.js";
import { toEntityId } from "../entity-id.js";
import { assertSchemaName, qualifiedTableName } from "../identifier.js";

export interface OneTimeTokenRepositoryOptions {
	readonly driver: Driver;
	readonly schema: string;
}

/**
 * `userId: null` writes the cover row S-TIM-6 needs: an address that names no account must cost the
 * same statements as one that does, and S-TOKEN-4 already answers such a row as no row (E-597).
 */
export type OneTimeTokenReplacement = {
	readonly tokenSha256: Uint8Array;
	readonly purpose: OneTimeTokenPurpose;
	readonly payload: OneTimeTokenPayload | null;
} & OneTimeTokenSubject;

export interface OneTimeTokenLookup {
	readonly tokenSha256: Uint8Array;
	readonly purpose: OneTimeTokenPurpose;
}

/** E-234: the removal proved the owner, so what comes back is the second lawful provenance of an `Actor`. */
export type StoredOneTimeToken = RedeemedOneTimeToken & {
	readonly payload: OneTimeTokenPayload | null;
};

export interface OneTimeTokenRepository {
	replaceOneTimeToken(input: OneTimeTokenReplacement): Promise<{ expiresAt: Date }>;
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
 * account identifier for the supersession that no account can answer to. Drawn afresh each time
 * rather than fixed, because a fixed one names a row an import could create — which is why it
 * cannot also be what the request serialises on (E-931).
 */
function anAccountThatCannotExist(): string {
	return crypto.randomUUID();
}

const FOREIGN_KEY_VIOLATION = "23503";

/** `pg` and `postgres.js` name it `code`, the test connection names it `sqlState`; both carry the
 * five characters PostgreSQL sent. */
function isForeignKeyViolation(cause: unknown): boolean {
	if (typeof cause !== "object" || cause === null) {
		return false;
	}
	const fields = cause as { readonly code?: unknown; readonly sqlState?: unknown };
	return fields.code === FOREIGN_KEY_VIOLATION || fields.sqlState === FOREIGN_KEY_VIOLATION;
}

/**
 * E-253 returned this as an ISO-8601 string so that no return type depended on the driver. A.7
 * declares `EmailMessage.expiresAt` a `Date` and the core may not call `new Date(`, so the only
 * source of one is the driver — the same bet every other repository here already makes, and the
 * same guard polices it (E-598).
 */
function toDate(value: unknown): Date {
	if (value instanceof Date) {
		return value;
	}
	throw new TypeError("the driver must decode timestamptz into a Date");
}

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

	/* S-TOKEN-3: the statement below is atomic, but at READ COMMITTED its DELETE works from the
	   snapshot the statement began with and therefore cannot remove a row a concurrent request
	   inserted after it, so the requests about one subject have to run one after another. The lock
	   is on the subject and not on the owner's row, because a row lock can only be taken where a row
	   exists — and a request that resolved to nobody would then wait where one that resolved to
	   somebody waits, which 5.3 (a) counts as an oracle (E-931). */
	const serialiseAndReadOwnerStatement = `SELECT pg_advisory_xact_lock(hashtextextended($2, 0)) AS serialised,
	(SELECT 1 FROM ${schema}.user owner WHERE owner.id = $1) AS owner_exists`;

	const replaceStatement = `WITH superseded AS (
	DELETE FROM ${table} WHERE user_id = $1 AND purpose = $2
)
INSERT INTO ${table} (token_sha256, purpose, user_id, payload, expires_at)
VALUES ($3, $2, $6, $4, now() + make_interval(secs => $5::double precision))
RETURNING expires_at`;

	// Section 3.7 word for word apart from the marker E-142 requires: the only way a token is read.
	const consumeStatement = `DELETE FROM ${table}
/* no owner predicate: S-TOKEN-4 */
WHERE token_sha256 = $1 AND purpose = $2 AND expires_at > now()
RETURNING user_id, payload`;

	return {
		async replaceOneTimeToken(replacement) {
			const { tokenSha256, purpose, userId, payload } = replacement;
			// Without this guard the not-null constraint on expires_at raises instead, and a
			// driver's error names the table and the constraint (E-263). The type rules the case
			// out; a caller that is not type-checked does not.
			if (!ONE_TIME_TOKEN_PURPOSES.includes(purpose)) {
				throw new OneTimeTokenError("one_time_token_purpose_unknown", null);
			}
			const lookupId = userId ?? anAccountThatCannotExist();
			const subject = userId === null ? replacement.serialisedOn : userId;
			return options.driver.transaction(async (tx) => {
				const [read] = await tx.query<{ owner_exists: unknown }>(serialiseAndReadOwnerStatement, [
					lookupId,
					subject,
				]);
				if (userId !== null && (read?.owner_exists ?? null) === null) {
					throw new OneTimeTokenError("one_time_token_owner_unknown", purpose);
				}
				// The account can be deleted between the read above and this insert, and without a
				// lock on its row nothing prevents that; the foreign key reports it and the code
				// E-263 wanted is put back on it here.
				const [row] = await tx
					.query<{ expires_at: unknown }>(replaceStatement, [
						lookupId,
						purpose,
						tokenSha256,
						payload === null ? null : JSON.stringify(payload),
						ONE_TIME_TOKEN_LIFETIME_SECONDS[purpose],
						userId,
					])
					.catch((failure: unknown) => {
						if (isForeignKeyViolation(failure)) {
							throw new OneTimeTokenError("one_time_token_owner_unknown", purpose);
						}
						throw failure;
					});
				if (row === undefined) {
					throw new OneTimeTokenError("one_time_token_not_written", purpose);
				}
				return { expiresAt: toDate(row.expires_at) };
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
