import type { Driver } from "./driver.js";
import { assertSchemaName, qualifiedTableName } from "./identifier.js";

/**
 * The one statement that orders two writes of one account against each other (CLAUDE.md §7). It is
 * written once so that the mode is not a per-call decision: `FOR NO KEY UPDATE` is the strongest
 * strength that does **not** conflict with the `FOR KEY SHARE` a foreign key takes on this row for
 * every insert of a user-owned row. `FOR UPDATE` does conflict with it, and that conflict is an edge
 * no reader sees in the SQL — it is what a reproduced deadlock between recovery-code regeneration and
 * recovery-code redemption was made of (E-1601, E-1604).
 */
export function lockAccountRowStatement(schema: string): string {
	return `SELECT 1 FROM ${qualifiedTableName(assertSchemaName(schema), "user")}
WHERE id = $1 FOR NO KEY UPDATE /* locks: ${schema}.user */`;
}

/**
 * Taken as the first statement of a transaction that writes rows in more than one user-owned table.
 * An account that does not exist locks nothing and raises nothing, so a caller running the statement
 * for an identifier that resolved to nobody runs the same statement as one that resolved (S-TIM-1).
 */
export async function lockAccountRow(
	driver: Driver,
	schema: string,
	userId: string,
): Promise<void> {
	await driver.query(lockAccountRowStatement(schema), [userId]);
}
