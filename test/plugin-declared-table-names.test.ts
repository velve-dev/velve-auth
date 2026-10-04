import { afterEach, describe, expect, it } from "vitest";
import type { OwnedMigration } from "../src/core/db/migration.js";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import {
	asTheMigrationRole,
	createTheMigrationRole,
	dropTheMigrationRole,
	type MigrationRole,
} from "./plugin-fixtures.js";

/**
 * A declared table name is handed to the runner's catalogue query, which decides the set of objects
 * a plugin owns (E-903, E-909, E-918). The prefix rule alone accepts `demo_entry,session` because it
 * begins with `demo_`, and the runner used to join the names with commas and split them again in
 * SQL — so that one name became two, and the second was the core table `session`.
 */
interface Opened {
	readonly connection: TestConnection;
	readonly schema: string;
	readonly role: MigrationRole;
}

const opened: Opened[] = [];

async function openSchema(): Promise<Opened> {
	const { connection, schema } = await openMigratedSchema("declaredname");
	const role = await createTheMigrationRole(connection, schema);
	const instance = { connection, schema, role };
	opened.push(instance);
	return instance;
}

afterEach(async () => {
	for (const instance of opened.splice(0)) {
		await dropSchema(instance.connection, instance.schema);
		await dropTheMigrationRole(instance.connection, instance.role);
		await instance.connection.close();
	}
});

async function indexesOfTheSessionTable(instance: Opened): Promise<readonly string[]> {
	const rows = await instance.connection.query<{ name: string }>(
		`SELECT index_.relname AS name FROM pg_index entry
		 JOIN pg_class index_ ON index_.oid = entry.indexrelid
		 JOIN pg_class table_ ON table_.oid = entry.indrelid
		 JOIN pg_namespace namespace_ ON namespace_.oid = table_.relnamespace
		 WHERE namespace_.nspname = $1 AND table_.relname = 'session'
		 ORDER BY index_.relname`,
		[instance.schema],
	);
	return rows.map((row) => row.name);
}

/**
 * The runner is reached directly so that its own reading of the names is what is measured. The first
 * migration creates the table its declared name spells, with a column of the session row type, so
 * that the table hangs off `session` in `pg_depend` the way the split-off name would claim it does.
 * The second migration then acts on `session` under the first one's declaration.
 */
async function runTheOwnedMigrations(
	instance: Opened,
	sql: string,
): Promise<{ readonly code?: string; readonly message?: string }> {
	const migrations: readonly OwnedMigration[] = [
		{
			version: 1,
			name: "declare_a_name_holding_a_comma",
			owner: "demo",
			createsTables: ["demo_entry,session"],
			sql: 'CREATE TABLE velve."demo_entry,session" (anchor velve.session);',
		},
		{ version: 2, name: "reach_the_session_table", owner: "demo", createsTables: [], sql },
	];
	return asTheMigrationRole(instance.role, (driver) =>
		runMigrations({ driver, schema: instance.schema, migrations })
			.then(() => ({}))
			.catch((error: { code?: string; message?: string }) => error),
	);
}

describe("the runner reads each declared name as one name (E-918)", () => {
	it("refuses a migration that drops a core index behind a name holding a comma", async () => {
		const instance = await openSchema();
		const before = await indexesOfTheSessionTable(instance);

		const refusal = await runTheOwnedMigrations(instance, "DROP INDEX velve.session_sweep_idx;");

		expect(refusal.code).toBe("migration_foreign_table_changed");
		expect(await indexesOfTheSessionTable(instance)).toEqual(before);
	});

	it("refuses a migration that renames a core index into its own prefix behind a name holding a comma", async () => {
		const instance = await openSchema();
		const before = await indexesOfTheSessionTable(instance);

		const refusal = await runTheOwnedMigrations(
			instance,
			"ALTER INDEX velve.session_user_id_idx RENAME TO demo_taken_over;",
		);

		expect(refusal.code).toBe("migration_foreign_table_changed");
		expect(await indexesOfTheSessionTable(instance)).toEqual(before);
	});

	it("reads a name holding a quote, a backslash and a brace as the one table it spells", async () => {
		const instance = await openSchema();
		const migration: OwnedMigration = {
			version: 1,
			name: "declare_a_name_holding_quotes",
			owner: "demo",
			createsTables: ['demo_q"\\{x}'],
			sql: 'CREATE TABLE velve."demo_q""\\{x}" (id integer PRIMARY KEY);',
		};

		const outcome = await asTheMigrationRole(instance.role, (driver) =>
			runMigrations({ driver, schema: instance.schema, migrations: [migration] })
				.then(() => ({}))
				.catch((error: { code?: string; message?: string }) => error),
		);

		expect(outcome).toEqual({});
	});
});
