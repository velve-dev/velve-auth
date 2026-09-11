import type { Actor, ConsumedRecoveryCode } from "../../db/actor.js";
import type { Driver } from "../../db/driver.js";
import { toEntityId } from "../../db/entity-id.js";
import { assertSchemaName, qualifiedTableName } from "../../db/identifier.js";
import { lockAccountRowStatement } from "../../db/lock.js";
import type { PepperedRecoveryCode } from "./pepper.js";

export interface RecoveryCodeRepositoryOptions {
	readonly driver: Driver;
	readonly schema: string;
}

export interface RecoveryCodeRepository {
	replaceEveryCode(input: {
		readonly actor: Actor;
		readonly codes: readonly PepperedRecoveryCode[];
	}): Promise<number>;
	pepperVersionsOf(input: { readonly userId: string }): Promise<readonly number[]>;
	/** E-234, E-612: the removal is what proved the owner, so it hands back that proof rather than a flag. */
	consumeCode(input: {
		readonly userId: string;
		readonly candidateHmacs: readonly Uint8Array<ArrayBuffer>[];
	}): Promise<ConsumedRecoveryCode | null>;
	countCodes(input: { readonly actor: Actor }): Promise<number>;
}

export class RecoveryCodeOwnerUnknownError extends Error {
	readonly code = "recovery_code_owner_unknown";

	constructor() {
		super("The account the recovery codes would belong to does not exist.");
		this.name = "RecoveryCodeOwnerUnknownError";
	}
}

export function createRecoveryCodeRepository(
	options: RecoveryCodeRepositoryOptions,
): RecoveryCodeRepository {
	const schema = assertSchemaName(options.schema);
	const table = qualifiedTableName(schema, "recovery_code");

	/* The delete and the insert have to be one atomic replacement of the whole set (3.6), and at
	   READ COMMITTED the delete works from the snapshot its statement began with. Serialising the
	   two generators of one account is what makes the replacement hold, and CLAUDE.md section 7
	   fixes both which row that lock is taken on and in which mode. */
	const lockOwnerStatement = lockAccountRowStatement(schema);

	const deleteEveryCodeStatement = `DELETE FROM ${table} WHERE user_id = $1`;

	const insertCodeStatement = `INSERT INTO ${table} (user_id, code_hmac, key_version)
VALUES ($1, $2, $3)`;

	/** Only the version numbers, never a stored value: what decides validity stays in the statement that removes the row (S-RACE-2). */
	const pepperVersionsStatement = `SELECT DISTINCT key_version FROM ${table} WHERE user_id = $1`;

	/* S-RACE-4 and S-REST-3: consumption is the single statement that removes the row, and the
	   primary key (user_id, code_hmac) serialises fifty writers onto one of them. A `bytea[]`
	   parameter would have to be spelled as an array literal, which every driver quotes
	   differently; one candidate per statement keeps the parameter a plain `bytea`. */
	const consumeStatement = `DELETE FROM ${table}
WHERE user_id = $1 AND code_hmac = $2
RETURNING key_version`;

	const countStatement = `SELECT count(*)::integer AS remaining FROM ${table} WHERE user_id = $1`;

	return {
		replaceEveryCode({ actor, codes }) {
			return options.driver.transaction(async (tx) => {
				const owner = await tx.query(lockOwnerStatement, [actor]);
				if (owner.length === 0) {
					throw new RecoveryCodeOwnerUnknownError();
				}
				await tx.query(deleteEveryCodeStatement, [actor]);
				for (const code of codes) {
					await tx.query(insertCodeStatement, [actor, code.codeHmac, code.keyVersion]);
				}
				return codes.length;
			});
		},

		async pepperVersionsOf({ userId }) {
			const rows = await options.driver.query<{ key_version: number }>(pepperVersionsStatement, [
				userId,
			]);
			return rows.map((row) => row.key_version);
		},

		async consumeCode({ userId, candidateHmacs }) {
			for (const candidateHmac of candidateHmacs) {
				const rows = await options.driver.query(consumeStatement, [userId, candidateHmac]);
				if (rows.length === 1) {
					// E-234: the brand is asserted where the row was removed and nowhere else.
					return { userId: toEntityId<"user">(userId) } as ConsumedRecoveryCode;
				}
			}
			return null;
		},

		async countCodes({ actor }) {
			const [row] = await options.driver.query<{ remaining: number }>(countStatement, [actor]);
			return row?.remaining ?? 0;
		},
	};
}
