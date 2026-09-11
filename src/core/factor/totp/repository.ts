import type { Actor } from "../../db/actor.js";
import type { Driver } from "../../db/driver.js";
import { assertSchemaName, qualifiedTableName } from "../../db/identifier.js";
import { lockAccountRow } from "../../db/lock.js";

export interface TotpRepositoryOptions {
	readonly driver: Driver;
	readonly schema: string;
}

export interface StoredTotpCredential {
	readonly secretEnc: Uint8Array<ArrayBuffer>;
	readonly keyVersion: number;
	readonly confirmedAt: Date | null;
}

export interface TotpCredentialInsert {
	readonly actor: Actor;
	readonly secretEnc: Uint8Array<ArrayBuffer>;
	readonly keyVersion: number;
}

export interface TimeStepClaim {
	readonly userId: string;
	readonly timeStep: number;
	readonly retentionSeconds: number;
}

export interface TotpRepository {
	/** Null when a confirmed credential already occupies the row (`factor_already_enrolled`). */
	putUnconfirmedCredential(input: TotpCredentialInsert): Promise<StoredTotpCredential | null>;
	findCredential(input: { actor: Actor }): Promise<StoredTotpCredential | null>;
	findCredentialOf(input: { userId: string }): Promise<StoredTotpCredential | null>;
	confirmCredential(input: { actor: Actor }): Promise<boolean>;
	removeCredential(input: { actor: Actor }): Promise<boolean>;
	claimTimeStep(input: TimeStepClaim): Promise<boolean>;
}

interface CredentialRow {
	secret_enc: Uint8Array;
	key_version: number;
	confirmed_at: Date | null;
}

function readCredential(row: CredentialRow | undefined): StoredTotpCredential | null {
	if (row === undefined) {
		return null;
	}
	return {
		secretEnc: Uint8Array.from(row.secret_enc),
		keyVersion: row.key_version,
		confirmedAt: row.confirmed_at,
	};
}

export function createTotpRepository(options: TotpRepositoryOptions): TotpRepository {
	const schema = assertSchemaName(options.schema);
	const credentials = qualifiedTableName(schema, "totp_credential");
	const usedSteps = qualifiedTableName(schema, "totp_used_step");

	/** An abandoned enrolment is data residue, so starting again overwrites it; a confirmed row is not touched. */
	const putUnconfirmedStatement = `INSERT INTO ${credentials} (user_id, secret_enc, key_version, confirmed_at)
VALUES ($1, $2, $3, NULL)
ON CONFLICT (user_id) DO UPDATE
SET secret_enc = EXCLUDED.secret_enc, key_version = EXCLUDED.key_version, created_at = now()
WHERE ${credentials}.user_id = $1 AND ${credentials}.confirmed_at IS NULL
RETURNING secret_enc, key_version, confirmed_at`;

	const findStatement = `SELECT secret_enc, key_version, confirmed_at FROM ${credentials}
WHERE user_id = $1`;

	const confirmStatement = `UPDATE ${credentials} SET confirmed_at = now()
WHERE user_id = $1 AND confirmed_at IS NULL
RETURNING user_id`;

	const removeCredentialStatement = `DELETE FROM ${credentials} WHERE user_id = $1 RETURNING user_id`;

	/** A re-enrolment must not inherit the previous secret's replay ledger, so the steps go with the credential. */
	const removeUsedStepsStatement = `DELETE FROM ${usedSteps} WHERE user_id = $1`;

	/* S-REPLAY-4 and S-RACE-3: the primary key is the whole check. The conflict is swallowed here
	   rather than raised so that the refusal does not depend on a driver surfacing SQLSTATE 23505,
	   which the Driver interface does not promise; PostgreSQL still serialises the fifty writers
	   on the key and hands a row to exactly one of them. */
	const claimStepStatement = `INSERT INTO ${usedSteps} (user_id, time_step, expires_at)
VALUES ($1, $2, now() + make_interval(secs => $3::double precision))
ON CONFLICT (user_id, time_step) DO NOTHING
RETURNING time_step`;

	return {
		async putUnconfirmedCredential({ actor, secretEnc, keyVersion }) {
			const [row] = await options.driver.query<CredentialRow>(putUnconfirmedStatement, [
				actor,
				secretEnc,
				keyVersion,
			]);
			return readCredential(row);
		},

		async findCredential({ actor }) {
			const [row] = await options.driver.query<CredentialRow>(findStatement, [actor]);
			return readCredential(row);
		},

		// The pending state is the ownership proof on a `caller: "pending"` route, so there is no actor to take.
		async findCredentialOf({ userId }) {
			const [row] = await options.driver.query<CredentialRow>(findStatement, [userId]);
			return readCredential(row);
		},

		async confirmCredential({ actor }) {
			const rows = await options.driver.query(confirmStatement, [actor]);
			return rows.length === 1;
		},

		removeCredential({ actor }) {
			return options.driver.transaction(async (tx) => {
				// CLAUDE.md §7: two user-owned tables are written below, so the account's row comes first.
				await lockAccountRow(tx, schema, actor);
				const removed = await tx.query(removeCredentialStatement, [actor]);
				await tx.query(removeUsedStepsStatement, [actor]);
				return removed.length === 1;
			});
		},

		async claimTimeStep({ userId, timeStep, retentionSeconds }) {
			const rows = await options.driver.query(claimStepStatement, [
				userId,
				timeStep,
				retentionSeconds,
			]);
			return rows.length === 1;
		},
	};
}
