import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MissingCascadeError } from "../src/core/db/cascade-guard.js";
import type { Migration } from "../src/core/db/migration.js";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import { dropSchema, uniqueSchemaName } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

let connection: TestConnection;
let schema: string;
let nextVersion = 100;

function pluginMigration(sql: string): Migration {
	nextVersion += 1;
	return { version: nextVersion, name: `plugin_${nextVersion}`, sql };
}

function apply(migration: Migration): Promise<unknown> {
	return runMigrations({
		driver: connection,
		schema,
		migrations: [...coreMigrations("email"), migration],
	});
}

async function tableExists(table: string): Promise<boolean> {
	const rows = await connection.query(
		"SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2",
		[schema, table],
	);
	return rows.length === 1;
}

async function ledgerVersions(): Promise<number[]> {
	const rows = await connection.query<{ version: number }>(
		`SELECT version FROM ${schema}.schema_migration ORDER BY version`,
		[],
	);
	return rows.map((row) => row.version);
}

beforeAll(async () => {
	connection = await openTestConnection();
	schema = uniqueSchemaName("velve_guard");
	await runMigrations({ driver: connection, schema, migrations: coreMigrations("email") });
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

describe("the cascade guard reads the catalogue, not the migration text (S-TOKEN-6)", () => {
	it("refuses a foreign key added by a second statement in the same migration", async () => {
		const migration = pluginMigration(`CREATE TABLE velve.guard_two_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL
);
ALTER TABLE velve.guard_two_statements
  ADD CONSTRAINT guard_two_statements_user_fk FOREIGN KEY (user_id) REFERENCES velve.user(id);`);

		await expect(apply(migration)).rejects.toBeInstanceOf(MissingCascadeError);
		expect(await tableExists("guard_two_statements")).toBe(false);
	});

	it("accepts a cascading foreign key added by a second statement", async () => {
		const migration = pluginMigration(`CREATE TABLE velve.guard_late_cascade (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL
);
ALTER TABLE velve.guard_late_cascade
  ADD CONSTRAINT guard_late_cascade_user_fk FOREIGN KEY (user_id)
  REFERENCES velve.user(id) ON DELETE CASCADE;`);

		await apply(migration);
		expect(await tableExists("guard_late_cascade")).toBe(true);
	});

	it("is not fooled by a comment that names the missing clause", async () => {
		const migration = pluginMigration(`-- ON DELETE CASCADE
CREATE TABLE velve.guard_comment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES velve.user(id) -- ON DELETE CASCADE
);`);

		await expect(apply(migration)).rejects.toBeInstanceOf(MissingCascadeError);
		expect(await tableExists("guard_comment")).toBe(false);
	});

	it("is not fooled by the clause sitting in a string literal", async () => {
		const migration = pluginMigration(`CREATE TABLE velve.guard_literal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note text NOT NULL DEFAULT 'ON DELETE CASCADE',
  user_id uuid NOT NULL REFERENCES velve.user(id)
);`);

		await expect(apply(migration)).rejects.toBeInstanceOf(MissingCascadeError);
		expect(await tableExists("guard_literal")).toBe(false);
	});

	it("accepts the clause however it is spelled and spaced", async () => {
		const migration = pluginMigration(`CREATE TABLE velve.guard_spacing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES velve.user(id)
     on
        delete
           cascade
);`);

		await apply(migration);
		expect(await tableExists("guard_spacing")).toBe(true);
	});

	it("refuses every other referential action", async () => {
		for (const action of ["SET NULL", "SET DEFAULT", "RESTRICT", "NO ACTION"]) {
			const table = `guard_${action.toLowerCase().replaceAll(" ", "_")}`;
			const migration = pluginMigration(`CREATE TABLE velve.${table} (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES velve.user(id) ON DELETE ${action}
);`);

			await expect(apply(migration)).rejects.toBeInstanceOf(MissingCascadeError);
			expect(await tableExists(table)).toBe(false);
		}
	});

	it("refuses a reference from a column that is not called user_id", async () => {
		const migration = pluginMigration(`CREATE TABLE velve.guard_other_name (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner uuid NOT NULL REFERENCES velve.user(id)
);`);

		await expect(apply(migration)).rejects.toBeInstanceOf(MissingCascadeError);
		expect(await tableExists("guard_other_name")).toBe(false);
	});

	it("refuses a user_id whose cascading foreign key points somewhere else", async () => {
		const migration = pluginMigration(`CREATE TABLE velve.guard_decoy_target (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);
CREATE TABLE velve.guard_decoy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES velve.guard_decoy_target(id) ON DELETE CASCADE
);`);

		await expect(apply(migration)).rejects.toBeInstanceOf(MissingCascadeError);
		expect(await tableExists("guard_decoy")).toBe(false);
		expect(await tableExists("guard_decoy_target")).toBe(false);
	});

	it("refuses a later migration that drops the cascade off a core table", async () => {
		const migration = pluginMigration(
			"ALTER TABLE velve.session DROP CONSTRAINT session_user_id_fkey;",
		);

		await expect(apply(migration)).rejects.toBeInstanceOf(MissingCascadeError);

		const rows = await connection.query<{ delete_action: string }>(
			`SELECT constraint_.confdeltype::text AS delete_action
			 FROM pg_constraint constraint_
			 JOIN pg_class child ON child.oid = constraint_.conrelid
			 JOIN pg_namespace namespace_ ON namespace_.oid = child.relnamespace
			 WHERE namespace_.nspname = $1 AND child.relname = 'session' AND constraint_.contype = 'f'`,
			[schema],
		);
		expect(rows.map((row) => row.delete_action)).toEqual(["c"]);
	});

	it("refuses a later migration that swaps a cascade for a restriction", async () => {
		const migration = pluginMigration(`ALTER TABLE velve.recovery_code
  DROP CONSTRAINT recovery_code_user_id_fkey,
  ADD CONSTRAINT recovery_code_user_id_fkey FOREIGN KEY (user_id) REFERENCES velve.user(id);`);

		await expect(apply(migration)).rejects.toBeInstanceOf(MissingCascadeError);
	});

	it("leaves every refused migration out of the ledger", async () => {
		const applied = await ledgerVersions();

		expect(applied).toEqual([1, 2, 102, 105]);
	});
});
