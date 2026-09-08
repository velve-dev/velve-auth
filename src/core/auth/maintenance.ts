import type { Driver } from "../db/driver.js";
import { qualifiedTableName } from "../db/identifier.js";

export interface SweepReport {
	readonly deletedRowsByTable: Readonly<Record<string, number>>;
}

/**
 * L-11: the seven tables that carry a `*_sweep_idx`, each with the column that index is on. There
 * is no HTTP route for this; `@velve/auth/schema` ships the same statements for `pg_cron`.
 */
const SWEPT_TABLES: readonly (readonly [table: string, deadlineColumn: string])[] = [
	["session", "absolute_expires_at"],
	["one_time_token", "expires_at"],
	["pending_authentication", "expires_at"],
	["totp_used_step", "expires_at"],
	["webauthn_challenge", "expires_at"],
	["oauth_flow", "expires_at"],
	["rate_bucket", "expires_at"],
];

function sweepStatements(schema: string): readonly string[] {
	return SWEPT_TABLES.map(
		([table, deadlineColumn]) =>
			`DELETE FROM ${qualifiedTableName(schema, table)} /* no owner predicate: S-OWNER-2, a deadline is not an owner */
	WHERE ${deadlineColumn} <= now() RETURNING 1 AS swept`,
	);
}

export async function sweepExpiredRows(input: {
	readonly driver: Driver;
	readonly schema: string;
}): Promise<SweepReport> {
	const deletedRowsByTable: Record<string, number> = {};
	const statements = sweepStatements(input.schema);
	for (const [index, [table]] of SWEPT_TABLES.entries()) {
		const statement = statements[index];
		if (statement === undefined) {
			continue;
		}
		deletedRowsByTable[table] = (await input.driver.query(statement, [])).length;
	}
	return { deletedRowsByTable };
}
