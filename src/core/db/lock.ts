import type { Driver } from "./driver.js";
import { assertSchemaName, qualifiedTableName } from "./identifier.js";

//no key update is the strongest mode that does not block the key share of a foreign key (E-1604)
export function lockAccountRowStatement(schema: string): string {
	return `SELECT 1 FROM ${qualifiedTableName(assertSchemaName(schema), "user")}
WHERE id = $1 FOR NO KEY UPDATE /* locks: ${schema}.user */`;
}

//a missing account locks nothing and raises nothing so both cases run the same statement (S-TIM-1)
export async function lockAccountRow(
	driver: Driver,
	schema: string,
	userId: string,
): Promise<void> {
	await driver.query(lockAccountRowStatement(schema), [userId]);
}
