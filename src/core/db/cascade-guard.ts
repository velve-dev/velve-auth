import type { Driver } from "./driver.js";
import { qualifiedTableName } from "./identifier.js";

const FOREIGN_KEYS_TO_USER_WITHOUT_CASCADE = `
SELECT child.relname AS table_name, constraint_.conname AS constraint_name
FROM pg_constraint constraint_
JOIN pg_class child ON child.oid = constraint_.conrelid
JOIN pg_namespace namespace_ ON namespace_.oid = child.relnamespace
WHERE namespace_.nspname = $1
  AND constraint_.contype = 'f'
  AND constraint_.confrelid = to_regclass($2)::oid
  AND constraint_.confdeltype <> 'c'
ORDER BY child.relname, constraint_.conname`;

const USER_ID_COLUMNS_WITHOUT_CASCADING_FOREIGN_KEY = `
SELECT child.relname AS table_name
FROM pg_attribute column_
JOIN pg_class child ON child.oid = column_.attrelid
JOIN pg_namespace namespace_ ON namespace_.oid = child.relnamespace
WHERE namespace_.nspname = $1
  AND child.relkind IN ('r', 'p')
  AND column_.attname = 'user_id'
  AND column_.attnum > 0
  AND NOT column_.attisdropped
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint constraint_
    WHERE constraint_.conrelid = child.oid
      AND constraint_.contype = 'f'
      AND constraint_.confrelid = to_regclass($2)::oid
      AND constraint_.confdeltype = 'c'
      AND column_.attnum = ANY (constraint_.conkey)
  )
ORDER BY child.relname`;

export class MissingCascadeError extends Error {
	readonly code = "migration_missing_cascade";

	constructor(message: string) {
		super(message);
		this.name = "MissingCascadeError";
	}
}

export async function assertEveryUserReferenceCascades(tx: Driver, schema: string): Promise<void> {
	const userTable = qualifiedTableName(schema, "user");

	const withoutCascade = await tx.query<{ table_name: string; constraint_name: string }>(
		FOREIGN_KEYS_TO_USER_WITHOUT_CASCADE,
		[schema, userTable],
	);
	if (withoutCascade.length > 0) {
		const offenders = withoutCascade
			.map((row) => `${schema}.${row.table_name} (${row.constraint_name})`)
			.join(", ");
		throw new MissingCascadeError(
			`refusing the migration: ${offenders} references ${userTable} without ON DELETE CASCADE`,
		);
	}

	const unreferenced = await tx.query<{ table_name: string }>(
		USER_ID_COLUMNS_WITHOUT_CASCADING_FOREIGN_KEY,
		[schema, userTable],
	);
	if (unreferenced.length > 0) {
		const offenders = unreferenced.map((row) => `${schema}.${row.table_name}`).join(", ");
		throw new MissingCascadeError(
			`refusing the migration: ${offenders} carries a user_id column without a foreign key to ${userTable} with ON DELETE CASCADE`,
		);
	}
}
