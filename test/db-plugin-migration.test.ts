import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MissingCascadeError } from "../src/core/db/cascade-guard.js";
import type { Migration } from "../src/core/db/migration.js";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import { UnrewritableMigrationError } from "../src/core/db/schema-rewrite.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

const schema = `velve_plugin_${randomBytes(6).toString("hex")}`;
let connection: TestConnection;

const cascadingPluginTable: Migration = {
	version: 100,
	name: "audit_trail",
	sql: `CREATE TABLE velve.audit_trail_entry (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
	note text NOT NULL
);`,
};

const restrictingPluginTable: Migration = {
	version: 101,
	name: "audit_trail_without_cascade",
	sql: `CREATE TABLE velve.audit_trail_orphan (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id uuid NOT NULL REFERENCES velve.user(id),
	note text NOT NULL
);`,
};

const unreferencedPluginTable: Migration = {
	version: 102,
	name: "audit_trail_without_foreign_key",
	sql: `CREATE TABLE velve.audit_trail_loose (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id uuid NOT NULL,
	note text NOT NULL
);`,
};

async function tableExists(table: string): Promise<boolean> {
	const rows = await connection.query(
		"SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2",
		[schema, table],
	);
	return rows.length === 1;
}

function runWith(migration: Migration): Promise<unknown> {
	return runMigrations({
		driver: connection,
		schema,
		migrations: [...coreMigrations("email"), migration],
	});
}

beforeAll(async () => {
	connection = await openTestConnection();
	await runMigrations({ driver: connection, schema, migrations: coreMigrations("email") });
});

afterAll(async () => {
	await connection.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, []);
	await connection.close();
});

describe("plugin migrations (S-TOKEN-6)", () => {
	it("accepts a plugin table whose foreign key cascades", async () => {
		await runWith(cascadingPluginTable);

		expect(await tableExists("audit_trail_entry")).toBe(true);
	});

	it("refuses a plugin table whose foreign key to the user does not cascade", async () => {
		await expect(runWith(restrictingPluginTable)).rejects.toBeInstanceOf(MissingCascadeError);

		expect(await tableExists("audit_trail_orphan")).toBe(false);
	});

	it("refuses a plugin table that carries user_id without a foreign key at all", async () => {
		await expect(runWith(unreferencedPluginTable)).rejects.toMatchObject({
			code: "migration_missing_cascade",
		});

		expect(await tableExists("audit_trail_loose")).toBe(false);
	});

	it("leaves the refused migrations out of the ledger", async () => {
		const rows = await connection.query<{ version: number }>(
			`SELECT version FROM ${schema}.schema_migration ORDER BY version`,
			[],
		);

		expect(rows.map((row) => row.version)).toEqual([1, 2, 100]);
	});
});

describe("plugin migrations with a function body", () => {
	const bodyNamingTheSchema: Migration = {
		version: 200,
		name: "audit_trail_counter",
		sql: `CREATE FUNCTION velve.audit_trail_count() RETURNS bigint LANGUAGE sql AS $$
	SELECT count(*) FROM velve.audit_trail_entry
$$;`,
	};

	const bodyNamingNothing: Migration = {
		version: 201,
		name: "audit_trail_answer",
		sql: `CREATE FUNCTION velve.audit_trail_answer() RETURNS integer LANGUAGE sql AS $$
	SELECT 42
$$;`,
	};

	it("refuses a body that qualifies the schema, because it is not rewritten", async () => {
		await expect(runWith(bodyNamingTheSchema)).rejects.toBeInstanceOf(UnrewritableMigrationError);

		const [row] = await connection.query<{ present: number }>(
			`SELECT count(*)::int AS present FROM pg_proc proc
			 JOIN pg_namespace namespace_ ON namespace_.oid = proc.pronamespace
			 WHERE namespace_.nspname = $1 AND proc.proname = 'audit_trail_count'`,
			[schema],
		);
		expect(row?.present).toBe(0);
	});

	it("applies a body that names no schema, and the function runs", async () => {
		await runWith(bodyNamingNothing);

		const [row] = await connection.query<{ answer: number }>(
			`SELECT ${schema}.audit_trail_answer() AS answer`,
			[],
		);
		expect(row?.answer).toBe(42);
	});
});

describe("plugin migrations that partition", () => {
	const partitionedWithoutCascade: Migration = {
		version: 300,
		name: "audit_trail_partitioned_loose",
		sql: `CREATE TABLE velve.audit_trail_shard (
	id uuid NOT NULL,
	user_id uuid NOT NULL
) PARTITION BY HASH (user_id);`,
	};

	const partitionedWithCascade: Migration = {
		version: 301,
		name: "audit_trail_partitioned",
		sql: `CREATE TABLE velve.audit_trail_bucket (
	id uuid NOT NULL,
	user_id uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE
) PARTITION BY HASH (user_id);`,
	};

	it("refuses a partitioned parent whose user_id has no cascading foreign key", async () => {
		await expect(runWith(partitionedWithoutCascade)).rejects.toBeInstanceOf(MissingCascadeError);

		expect(await tableExists("audit_trail_shard")).toBe(false);
	});

	it("accepts a partitioned parent that cascades", async () => {
		await runWith(partitionedWithCascade);

		expect(await tableExists("audit_trail_bucket")).toBe(true);
	});
});
