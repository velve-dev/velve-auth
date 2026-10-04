import type { Driver } from "../db/driver.js";
import {
	assertIdentifier,
	assertSchemaName,
	InvalidIdentifierError,
	qualifiedTableName,
} from "../db/identifier.js";
import type { OwnedMigration } from "../db/migration.js";
import { coreTableNameSet, namesTableOfPlugin } from "../db/migrations/index.js";

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

const PLUGIN_STATEMENT_SAVEPOINT = "velve_plugin_statement";

//a plugin statement that fails must not abort the transaction it borrowed (E-2586)
export async function runInsideASavepoint<Row>(
	transaction: Driver,
	statement: () => Promise<Row[]>,
): Promise<Row[]> {
	await transaction.query(`SAVEPOINT ${PLUGIN_STATEMENT_SAVEPOINT}`, []);
	try {
		const rows = await statement();
		await transaction.query(`RELEASE SAVEPOINT ${PLUGIN_STATEMENT_SAVEPOINT}`, []);
		return rows;
	} catch (error) {
		await transaction.query(`ROLLBACK TO SAVEPOINT ${PLUGIN_STATEMENT_SAVEPOINT}`, []);
		await transaction.query(`RELEASE SAVEPOINT ${PLUGIN_STATEMENT_SAVEPOINT}`, []);
		throw error;
	}
}

//the role a borrowed transaction had must be back before the next core statement runs (E-2584)
export async function runAsThePluginRoleInsideATransaction<Row>(
	transaction: Driver,
	role: string,
	sql: string,
	params: readonly unknown[],
): Promise<Row[]> {
	const [held] = await transaction.query<{ role: string }>(
		"SELECT current_setting('role') AS role",
		[],
	);
	return runInsideASavepoint(transaction, async () => {
		await transaction.query(`SET LOCAL ROLE ${role}`, []);
		const rows = await transaction.query<Row>(sql, [...params]);
		await transaction.query("SELECT set_config('role', $1, true)", [held?.role ?? "none"]);
		return rows;
	});
}

const SEQUENCES_OF_THE_TABLES = `
SELECT sequence_.relname AS name
FROM pg_class sequence_
JOIN pg_depend depend ON depend.classid = 'pg_class'::regclass AND depend.objid = sequence_.oid
JOIN pg_class owner_ ON depend.refclassid = 'pg_class'::regclass AND owner_.oid = depend.refobjid
JOIN pg_namespace namespace_ ON namespace_.oid = owner_.relnamespace
WHERE sequence_.relkind = 'S' AND namespace_.nspname = $1
  AND owner_.relname = $2`;

const EXISTING_TABLES = `
SELECT child.relname AS name
FROM pg_class child
JOIN pg_namespace namespace_ ON namespace_.oid = child.relnamespace
WHERE namespace_.nspname = $1 AND child.relkind IN ('r', 'p')
  AND child.relname = $2`;

//a declared name is read from configuration and must name one table of its plugin and no core table
function grantableTableOf(migration: OwnedMigration, declared: string): string {
	const table = assertIdentifier(declared);
	if (!namesTableOfPlugin(table, migration.owner) || coreTableNameSet().has(table)) {
		throw new InvalidIdentifierError(
			table,
			`plugin ${migration.owner} may be granted its own tables only`,
		);
	}
	return table;
}

function declaredTablesOf(migrations: readonly OwnedMigration[]): readonly string[] {
	const declared = migrations.flatMap((migration) =>
		migration.createsTables.map((table) => grantableTableOf(migration, table)),
	);
	return [...new Set(declared)].sort();
}

//a role configured after the tables were created must still be granted them
export async function grantOwnTablesToThePluginRole(options: {
	readonly driver: Driver;
	readonly schema: string;
	readonly role: string;
	readonly migrations: readonly OwnedMigration[];
}): Promise<void> {
	const { driver, schema, role } = options;
	const declared = declaredTablesOf(options.migrations);
	await driver.transaction(async (tx) => {
		await tx.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`, []);
		for (const table of declared) {
			await grantOneTable(tx, schema, role, table);
		}
	});
}

//one name per lookup so no separator inside a name can widen the grant
async function grantOneTable(
	tx: Driver,
	schema: string,
	role: string,
	table: string,
): Promise<void> {
	const existing = await tx.query<{ name: string }>(EXISTING_TABLES, [schema, table]);
	if (existing.length === 0) {
		return;
	}
	await tx.query(
		`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${qualifiedTableName(schema, table)} TO ${role}`,
		[],
	);
	const sequences = await tx.query<{ name: string }>(SEQUENCES_OF_THE_TABLES, [schema, table]);
	for (const sequence of sequences) {
		await tx.query(
			`GRANT USAGE, SELECT, UPDATE ON SEQUENCE ${qualifiedTableName(schema, sequence.name)} TO ${role}`,
			[],
		);
	}
}
