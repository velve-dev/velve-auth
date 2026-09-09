import { afterEach, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import type { VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";

interface Opened {
	readonly connection: TestConnection;
	readonly schema: string;
	migrate(plugin: VelvePlugin): Promise<{ readonly code?: string }>;
}

const opened: Opened[] = [];

async function openSchema(): Promise<Opened> {
	const { connection, schema } = await openMigratedSchema("pluginreads");
	const instance: Opened = {
		connection,
		schema,
		migrate: (plugin) =>
			createVelveAuth(configFor({ database: connection as Driver, schema, plugins: [plugin] }))
				.migrate()
				.then(() => ({}))
				.catch((error: { code?: string }) => error),
	};
	opened.push(instance);
	return instance;
}

afterEach(async () => {
	for (const instance of opened.splice(0)) {
		await dropSchema(instance.connection, instance.schema);
		await instance.connection.close();
	}
});

async function relationExists(instance: Opened, name: string): Promise<boolean> {
	const rows = await instance.connection.query(
		`SELECT 1 FROM pg_class child
		 JOIN pg_namespace namespace_ ON namespace_.oid = child.relnamespace
		 WHERE namespace_.nspname = $1 AND child.relname = $2`,
		[instance.schema, name],
	);
	return rows.length > 0;
}

function migration(id: string, sql: string, createsTables: readonly string[]): VelvePlugin {
	return {
		id,
		migrations: [{ version: 1, name: "reach", createsTables, sql }],
	} as unknown as VelvePlugin;
}

/**
 * `velve.user`, `velve.password_credential`, `velve.session` and `velve.identity` each carry a
 * unique key, so each can be pointed at by a foreign key of a plugin's own — and the allowance
 * granted for the sake of constraint checking served a complete copy of the table instead.
 */
describe("what a plugin migration may read of a table it does not own (3.11)", () => {
	it("refuses a copy of velve.user taken through a table that references it", async () => {
		const instance = await openSchema();
		await createUser(instance.connection, instance.schema);

		const refusal = await instance.migrate(
			migration(
				"audit",
				`CREATE TABLE velve.audit_copy (
					uid uuid PRIMARY KEY REFERENCES velve.user(id) ON DELETE CASCADE,
					email text);
				INSERT INTO velve.audit_copy SELECT id, email FROM velve.user;`,
				["audit_copy"],
			),
		);

		expect(refusal.code).toBe("migration_read_a_foreign_table");
		expect(await relationExists(instance, "audit_copy")).toBe(false);
	});

	/**
	 * `_` is a single-character wildcard in `LIKE`, so the allowance was keyed on a pattern that
	 * matched `velve.session` for a plugin called `sessio` — one that references nothing at all.
	 */
	it("refuses a plugin whose prefix matches a core table only as a LIKE wildcard", async () => {
		const instance = await openSchema();
		await createUser(instance.connection, instance.schema);

		const refusal = await instance.migrate(
			migration(
				"sessio",
				`CREATE TABLE velve.sessio_copy (uid uuid, email text);
				INSERT INTO velve.sessio_copy SELECT id, email FROM velve.user;`,
				["sessio_copy"],
			),
		);

		expect(refusal.code).toBe("migration_read_a_foreign_table");
		expect(await relationExists(instance, "sessio_copy")).toBe(false);
	});

	it("applies the ordinary plugin table, which references velve.user and reads no row of it", async () => {
		const instance = await openSchema();

		const refusal = await instance.migrate(
			migration(
				"audit",
				`CREATE TABLE velve.audit_entry (
					id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
					user_id uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
					note text NOT NULL);
				CREATE INDEX audit_entry_user ON velve.audit_entry (user_id);`,
				["audit_entry"],
			),
		);

		expect(refusal.code).toBeUndefined();
		expect(await relationExists(instance, "audit_entry")).toBe(true);
	});
});

/**
 * The kinds a migration may leave behind are enumerated positively — every object it created must
 * belong to one of its own tables — because a list of the catalogues it may not write is a list
 * PostgreSQL lengthens with every release.
 */
describe("what a plugin migration may create beside a relation (3.11)", () => {
	it("refuses an enumerated type, which is a relation of no kind at all", async () => {
		const instance = await openSchema();

		const refusal = await instance.migrate(
			migration("audit", "CREATE TYPE velve.audit_kind AS ENUM ('opened', 'closed');", []),
		);

		expect(refusal.code).toBe("migration_created_more_than_a_table");
	});

	it("names a composite type by its name rather than by its catalogue letter", async () => {
		const instance = await openSchema();

		const refusal = await instance.migrate(
			migration("audit", "CREATE TYPE velve.audit_pair AS (a integer, b integer);", []),
		);

		expect(refusal.code).toBe("migration_created_more_than_a_table");
		expect((refusal as { message?: string }).message).toContain(`${instance.schema}.audit_pair`);
		expect((refusal as { message?: string }).message).not.toContain('kind "c"');
	});

	it("refuses a collation, which no rule in this runner is written about", async () => {
		const instance = await openSchema();

		const refusal = await instance.migrate(
			migration("audit", "CREATE COLLATION velve.audit_order (locale = 'C');", []),
		);

		expect(refusal.code).toBe("migration_created_more_than_a_table");
		expect((refusal as { message?: string }).message).toContain("audit_order");
	});

	it("applies a table whose columns bring a sequence and a check constraint with them", async () => {
		const instance = await openSchema();

		const refusal = await instance.migrate(
			migration(
				"audit",
				`CREATE TABLE velve.audit_counted (
					id bigserial PRIMARY KEY,
					user_id uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
					weight integer NOT NULL DEFAULT 1 CHECK (weight > 0),
					note text);
				CREATE UNIQUE INDEX audit_counted_user ON velve.audit_counted (user_id);`,
				["audit_counted"],
			),
		);

		expect(refusal.code).toBeUndefined();
		expect(await relationExists(instance, "audit_counted")).toBe(true);
	});

	it("refuses a function even where the plugin leaves it in its own schema", async () => {
		const instance = await openSchema();

		const refusal = await instance.migrate(
			migration(
				"audit",
				"CREATE FUNCTION velve.audit_touch() RETURNS integer AS $body$ SELECT 1 $body$ LANGUAGE sql;",
				[],
			),
		);

		expect(refusal.code).toBe("migration_left_code_behind");
	});
});
