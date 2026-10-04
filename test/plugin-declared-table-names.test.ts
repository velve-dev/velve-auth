import { afterEach, describe, expect, it } from "vitest";
import { VelveStartupError } from "../src/core/auth/startup.js";
import type { Driver } from "../src/core/db/driver.js";
import type { OwnedMigration } from "../src/core/db/migration.js";
import { runMigrations } from "../src/core/db/migration-runner.js";
import type { VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import {
	asTheMigrationRole,
	createTheMigrationRole,
	dropTheMigrationRole,
	type MigrationRole,
	unreachableDriver,
} from "./plugin-fixtures.js";

/**
 * A declared table name is handed to the runner's catalogue query, which decides the set of objects
 * a plugin owns (E-903, E-909, E-918). The prefix rule alone accepts `demo_entry,session` because it
 * begins with `demo_`, and the runner used to join the names with commas and split them again in
 * SQL — so that one name became two, and the second was the core table `session`.
 */
const MALFORMED_NAMES: readonly string[] = [
	"demo_entry,session",
	'demo_entry"',
	"demo_entry session",
	"demo_entry\tsession",
	"demo_entry.session",
	"demo_Entry",
	`demo_${"x".repeat(60)}`,
];

function pluginDeclaring(table: string, sql = "SELECT 1"): VelvePlugin {
	return {
		id: "demo",
		migrations: [{ version: 1, name: "declare_the_table", createsTables: [table], sql }],
	} as unknown as VelvePlugin;
}

function codeOfTheStart(plugin: VelvePlugin, database: Driver = unreachableDriver()): string {
	try {
		createVelveAuth(configFor({ database, plugins: [plugin] }));
	} catch (cause) {
		return cause instanceof VelveStartupError ? cause.code : `not a start error: ${String(cause)}`;
	}
	return "the configuration started";
}

describe("a declared table name is a plain identifier (3.11, S-DEFAULT-5)", () => {
	for (const name of MALFORMED_NAMES) {
		it(`refuses the start for the declared name ${JSON.stringify(name)}`, () => {
			expect(codeOfTheStart(pluginDeclaring(name))).toBe(
				"plugin_migration_table_not_an_identifier",
			);
		});
	}

	it("still starts with a well-formed name inside the plugin's prefix", () => {
		expect(codeOfTheStart(pluginDeclaring("demo_entry"))).toBe("the configuration started");
	});

	it("still refuses a well-formed name outside the prefix as not prefixed", () => {
		expect(codeOfTheStart(pluginDeclaring("other_entry"))).toBe(
			"plugin_migration_table_not_prefixed",
		);
	});
});

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

	it("refuses one declared name holding a comma for the two tables it would spell", async () => {
		const instance = await openSchema();

		const refusal = await runAsTheMigrationRole(instance, [
			ownedMigration(
				1,
				["demo_a,demo_b"],
				"CREATE TABLE velve.demo_a (id integer); CREATE TABLE velve.demo_b (id integer);",
			),
		]);

		expect(refusal.code).toBe("migration_table_undeclared");
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

async function runAsTheMigrationRole(
	instance: Opened,
	migrations: readonly OwnedMigration[],
): Promise<{ readonly code?: string; readonly message?: string }> {
	return asTheMigrationRole(instance.role, (driver) =>
		runMigrations({ driver, schema: instance.schema, migrations })
			.then(() => ({}))
			.catch((error: { code?: string; message?: string }) => error),
	);
}

function ownedMigration(
	version: number,
	createsTables: readonly string[],
	sql: string,
): OwnedMigration {
	return { version, name: `step_${version}`, owner: "demo", createsTables, sql };
}

async function parentsOf(instance: Opened, table: string): Promise<number> {
	const rows = await instance.connection.query<{ parents: number }>(
		`SELECT count(*)::integer AS parents FROM pg_inherits
		 WHERE inhrelid = to_regclass($1 || '.' || $2) OR inhparent = to_regclass($1 || '.' || $2)`,
		[instance.schema, table],
	);
	return rows[0]?.parents ?? -1;
}

async function constraintsOfTheSessionTable(instance: Opened): Promise<readonly string[]> {
	const rows = await instance.connection.query<{ name: string }>(
		`SELECT conname AS name FROM pg_constraint
		 WHERE conrelid = to_regclass($1 || '.session') ORDER BY conname`,
		[instance.schema],
	);
	return rows.map((row) => row.name);
}

/**
 * The owned set follows only the dependencies a table brings with it, and an inheritance edge is
 * not one of them: a plugin table cannot adopt a core table as its child, nor be one (E-2483).
 */
describe("the owned set reaches only what a table brings with it (E-918)", () => {
	it("refuses a plugin table that inherits from the account table", async () => {
		const instance = await openSchema();

		const refusal = await runAsTheMigrationRole(instance, [
			ownedMigration(1, ["demo_child"], "CREATE TABLE velve.demo_child () INHERITS (velve.user);"),
		]);

		expect(refusal.code).toBe("migration_foreign_table_changed");
		expect(await parentsOf(instance, "user")).toBe(0);
	});

	it("refuses a plugin table that inherits from the account table when no catalogue row of it changes", async () => {
		const instance = await openSchema();
		//relhassubclass stays set after the child is gone so inheriting again leaves the user row untouched
		await instance.connection.query(
			`CREATE TABLE public.${instance.schema}_earlier_child () INHERITS (${instance.schema}.user)`,
			[],
		);
		await instance.connection.query(`DROP TABLE public.${instance.schema}_earlier_child`, []);

		const refusal = await runAsTheMigrationRole(instance, [
			ownedMigration(1, ["demo_child"], "CREATE TABLE velve.demo_child () INHERITS (velve.user);"),
		]);

		expect(refusal.code).toBe("migration_foreign_table_changed");
		expect(refusal.message).toContain("inherit");
		expect(await parentsOf(instance, "user")).toBe(0);
	});

	it("refuses a core table attached to a plugin table by a foreign key nothing validated", async () => {
		const instance = await openSchema();
		const before = await constraintsOfTheSessionTable(instance);

		const refusal = await runAsTheMigrationRole(instance, [
			ownedMigration(
				1,
				["demo_anchor"],
				`CREATE TABLE velve.demo_anchor (id uuid PRIMARY KEY);
				 ALTER TABLE velve.session ADD CONSTRAINT demo_anchor_fk FOREIGN KEY (user_id)
				   REFERENCES velve.demo_anchor ON DELETE CASCADE NOT VALID;`,
			),
		]);

		expect(refusal.code).toBe("migration_created_more_than_a_table");
		expect(await constraintsOfTheSessionTable(instance)).toEqual(before);
	});

	it("still accepts what a plugin's own tables bring with them", async () => {
		const instance = await openSchema();

		const outcome = await runAsTheMigrationRole(instance, [
			ownedMigration(
				1,
				["demo_entry", "demo_part", "demo_part_low", "demo_base", "demo_derived"],
				`CREATE TABLE velve.demo_entry (
				   id serial PRIMARY KEY,
				   counter integer GENERATED ALWAYS AS IDENTITY,
				   user_id uuid NOT NULL REFERENCES velve.user (id) ON DELETE CASCADE,
				   label text NOT NULL DEFAULT 'none' CHECK (length(label) < 100)
				 );
				 CREATE INDEX demo_entry_user_idx ON velve.demo_entry (user_id);
				 CREATE TABLE velve.demo_part (id integer, bucket integer NOT NULL) PARTITION BY RANGE (bucket);
				 CREATE TABLE velve.demo_part_low PARTITION OF velve.demo_part FOR VALUES FROM (0) TO (10);
				 CREATE INDEX demo_part_id_idx ON velve.demo_part (id);
				 CREATE TABLE velve.demo_base (id integer);
				 CREATE TABLE velve.demo_derived (extra integer) INHERITS (velve.demo_base);`,
			),
			ownedMigration(
				2,
				[],
				`DROP INDEX velve.demo_entry_user_idx;
				 ALTER TABLE velve.demo_derived NO INHERIT velve.demo_base;
				 DROP TABLE velve.demo_part;`,
			),
		]);

		expect(outcome).toEqual({});
	});
});
