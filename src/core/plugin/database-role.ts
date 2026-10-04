import type { Driver } from "../db/driver.js";
import { assertSchemaName, InvalidIdentifierError, qualifiedTableName } from "../db/identifier.js";
import type { OwnedMigration } from "../db/migration.js";

//none, public and a pg_ name must not become the role plugin SQL runs as
const NAMES_NO_SWITCHABLE_ROLE = /^(?:none|public|pg_.*)$/;

export function assertPluginDatabaseRole(role: string): string {
	assertSchemaName(role);
	if (NAMES_NO_SWITCHABLE_ROLE.test(role)) {
		throw new InvalidIdentifierError(role, "it does not name a role plugin SQL can be switched to");
	}
	return role;
}

//the role must hold for the one statement and end with its transaction (S-OWNER-10)
export function runAsThePluginRole<Row>(
	driver: Driver,
	role: string,
	sql: string,
	params: readonly unknown[],
): Promise<Row[]> {
	return driver.transaction(async (tx) => {
		await tx.query(`SET LOCAL ROLE ${role}`, []);
		return tx.query<Row>(sql, [...params]);
	});
}

const SEQUENCES_OF_THE_TABLES = `
SELECT sequence_.relname AS name
FROM pg_class sequence_
JOIN pg_depend depend ON depend.classid = 'pg_class'::regclass AND depend.objid = sequence_.oid
JOIN pg_class owner_ ON depend.refclassid = 'pg_class'::regclass AND owner_.oid = depend.refobjid
JOIN pg_namespace namespace_ ON namespace_.oid = owner_.relnamespace
WHERE sequence_.relkind = 'S' AND namespace_.nspname = $1
  AND owner_.relname = ANY(string_to_array($2, ','))`;

const EXISTING_TABLES = `
SELECT child.relname AS name
FROM pg_class child
JOIN pg_namespace namespace_ ON namespace_.oid = child.relnamespace
WHERE namespace_.nspname = $1 AND child.relkind IN ('r', 'p')
  AND child.relname = ANY(string_to_array($2, ','))`;

function declaredTablesOf(migrations: readonly OwnedMigration[]): readonly string[] {
	return [...new Set(migrations.flatMap((migration) => migration.createsTables))].sort();
}

//a role configured after the tables were created must still be granted them
export async function grantOwnTablesToThePluginRole(options: {
	readonly driver: Driver;
	readonly schema: string;
	readonly role: string;
	readonly migrations: readonly OwnedMigration[];
}): Promise<void> {
	const { driver, schema, role } = options;
	const declared = declaredTablesOf(options.migrations).join(",");
	await driver.transaction(async (tx) => {
		await tx.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`, []);
		const tables = await tx.query<{ name: string }>(EXISTING_TABLES, [schema, declared]);
		for (const table of tables) {
			await tx.query(
				`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${qualifiedTableName(schema, table.name)} TO ${role}`,
				[],
			);
		}
		const sequences = await tx.query<{ name: string }>(SEQUENCES_OF_THE_TABLES, [schema, declared]);
		for (const sequence of sequences) {
			await tx.query(
				`GRANT USAGE, SELECT, UPDATE ON SEQUENCE ${qualifiedTableName(schema, sequence.name)} TO ${role}`,
				[],
			);
		}
	});
}
