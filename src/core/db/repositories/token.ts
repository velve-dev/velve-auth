import { type StoredPayload, type StoredTokenMac, storedPayloadOf } from "../../token/binding.js";
import {
	ONE_TIME_TOKEN_LIFETIME_SECONDS,
	ONE_TIME_TOKEN_PURPOSES,
	type OneTimeTokenPayload,
	type OneTimeTokenPurpose,
	type OneTimeTokenSubject,
} from "../../token/purpose.js";
import { randomUuid } from "../../token/random.js";
import type { Actor, RedeemedOneTimeToken } from "../actor.js";
import type { Driver } from "../driver.js";
import { toEntityId } from "../entity-id.js";
import { assertSchemaName, qualifiedTableName } from "../identifier.js";

export interface OneTimeTokenRepositoryOptions {
	readonly driver: Driver;
	readonly schema: string;
}

//an address without an account must cost the same statements as one with an account (S-TIM-6)
export type OneTimeTokenReplacement = {
	readonly tokenSha256: Uint8Array;
	readonly purpose: OneTimeTokenPurpose;
	readonly payload: OneTimeTokenPayload | null;
} & OneTimeTokenSubject &
	StoredTokenMac;

export interface OneTimeTokenLookup {
	readonly tokenSha256: Uint8Array;
	readonly purpose: OneTimeTokenPurpose;
}

//the removal proved the owner so this is a lawful provenance of an actor (E-234)
type StoredOneTimeToken = RedeemedOneTimeToken & {
	readonly payload: OneTimeTokenPayload | null;
};

interface ConsumedOneTimeToken extends StoredTokenMac {
	readonly storedPayload: StoredPayload;
}

/** a removed row whose MAC is still to be checked before its owner or payload is used */
export type OneTimeTokenCandidate = ConsumedOneTimeToken &
	({ readonly userId: null } | { readonly userId: string; accept(): StoredOneTimeToken });

export interface OneTimeTokenRepository {
	replaceOneTimeToken(input: OneTimeTokenReplacement): Promise<{ expiresAt: Date }>;
	//a row that names no account is still checked and then answered exactly as no row is (S-TOKEN-4)
	consumeOneTimeToken(input: OneTimeTokenLookup): Promise<OneTimeTokenCandidate | null>;
	//a confirmed change of address withdraws every link still mailed to the old one (S-INTEG-9)
	withdrawTokensOf(input: {
		readonly actor: Actor;
		readonly purpose: OneTimeTokenPurpose;
	}): Promise<void>;
}

export type OneTimeTokenErrorCode =
	| "one_time_token_owner_unknown"
	| "one_time_token_purpose_unknown"
	| "one_time_token_not_written";

//messages are fixed per code so nothing the caller passed reaches an error string (E-263)
const MESSAGE_BY_ERROR_CODE: Readonly<Record<OneTimeTokenErrorCode, string>> = {
	one_time_token_owner_unknown: "The account the token would belong to does not exist.",
	one_time_token_purpose_unknown: "The purpose is not one of the four one-time token purposes.",
	one_time_token_not_written: "The insert reported no row.",
};

export class OneTimeTokenError extends Error {
	readonly code: OneTimeTokenErrorCode;

	//the purpose travels in its own field and is never spliced into the message (E-265)
	readonly purpose: OneTimeTokenPurpose | null;

	constructor(code: OneTimeTokenErrorCode, purpose: OneTimeTokenPurpose | null) {
		super(MESSAGE_BY_ERROR_CODE[code]);
		this.name = "OneTimeTokenError";
		this.code = code;
		this.purpose = purpose;
	}
}

//drawn afresh each time as a fixed id could name a row an import creates (E-931)
function anAccountThatCannotExist(): string {
	return randomUuid();
}

const FOREIGN_KEY_VIOLATION = "23503";

//drivers name the sql state either code or sql state so both are read
function isForeignKeyViolation(cause: unknown): boolean {
	if (typeof cause !== "object" || cause === null) {
		return false;
	}
	const fields = cause as { readonly code?: unknown; readonly sqlState?: unknown };
	return fields.code === FOREIGN_KEY_VIOLATION || fields.sqlState === FOREIGN_KEY_VIOLATION;
}

//only the driver may produce a date as the core may not construct one (E-598)
function toDate(value: unknown): Date {
	if (value instanceof Date) {
		return value;
	}
	throw new TypeError("the driver must decode timestamptz into a Date");
}

//this is the only place where a redemption becomes evidence of an owner (E-93)
function redeemedBy(userId: string, payload: OneTimeTokenPayload | null): StoredOneTimeToken {
	return { userId: toEntityId<"user">(userId), payload } as StoredOneTimeToken;
}

interface ConsumedRowShape {
	readonly user_id: string | null;
	readonly payload_text: string | null;
	readonly token_mac: Uint8Array;
	readonly token_mac_key_version: number;
}

export function createOneTimeTokenRepository(
	options: OneTimeTokenRepositoryOptions,
): OneTimeTokenRepository {
	const schema = assertSchemaName(options.schema);
	const table = qualifiedTableName(schema, "one_time_token");

	//requests about one subject run in turn as the delete cannot see newer rows (S-TOKEN-3)
	const serialiseAndReadOwnerStatement = `SELECT pg_advisory_xact_lock(hashtextextended($2, 0)) AS serialised,
	(SELECT 1 FROM ${schema}.user owner WHERE owner.id = $1) AS owner_exists`;

	const replaceStatement = `WITH superseded AS (
	DELETE FROM ${table} WHERE user_id = $1 AND purpose = $2
)
INSERT INTO ${table}
	(token_sha256, purpose, user_id, payload, expires_at, token_mac, token_mac_key_version)
VALUES ($3, $2, $6, $4, now() + make_interval(secs => $5::double precision), $7, $8)
RETURNING expires_at`;

	//the consume statement must stay the specified one apart from its marker (E-142)
	const consumeStatement = `DELETE FROM ${table}
/* no owner predicate: S-TOKEN-4 */
WHERE token_sha256 = $1 AND purpose = $2 AND expires_at > now()
RETURNING user_id, payload::text AS payload_text, token_mac, token_mac_key_version`;

	const withdrawStatement = `DELETE FROM ${table} WHERE user_id = $1 AND purpose = $2`;

	return {
		async replaceOneTimeToken(replacement) {
			const { tokenSha256, purpose, userId, payload } = replacement;
			//an unknown purpose must not reach the constraint whose error names the table (E-263)
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
				//an account deleted since the read must still fail with its own code (E-263)
				const [row] = await tx
					.query<{ expires_at: unknown }>(replaceStatement, [
						lookupId,
						purpose,
						tokenSha256,
						payload === null ? null : JSON.stringify(payload),
						ONE_TIME_TOKEN_LIFETIME_SECONDS[purpose],
						userId,
						replacement.tokenMac,
						replacement.tokenMacKeyVersion,
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
			const [row] = await options.driver.query<ConsumedRowShape>(consumeStatement, [
				tokenSha256,
				purpose,
			]);
			if (row === undefined) {
				return null;
			}
			const userId = row.user_id;
			const storedPayload = storedPayloadOf(row.payload_text);
			const consumed = {
				storedPayload,
				tokenMac: row.token_mac,
				tokenMacKeyVersion: row.token_mac_key_version,
			};
			return userId === null
				? { ...consumed, userId }
				: { ...consumed, userId, accept: () => redeemedBy(userId, storedPayload?.payload ?? null) };
		},

		async withdrawTokensOf({ actor, purpose }) {
			await options.driver.query(withdrawStatement, [actor, purpose]);
		},
	};
}
