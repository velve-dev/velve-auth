import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Migration } from "../src/core/db/migration.js";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import { dropSchema, uniqueSchemaName } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

let connection: TestConnection;
const schemas: string[] = [];

function freshSchema(prefix: string): string {
	const schema = uniqueSchemaName(prefix);
	schemas.push(schema);
	return schema;
}

beforeAll(async () => {
	connection = await openTestConnection();
});

afterAll(async () => {
	for (const schema of schemas) {
		await dropSchema(connection, schema);
	}
	await connection.close();
});

async function ledgerVersions(schema: string): Promise<number[]> {
	const rows = await connection.query<{ version: number }>(
		`SELECT version FROM ${schema}.schema_migration ORDER BY version`,
		[],
	);
	return rows.map((row) => row.version);
}

async function tableExists(schema: string, table: string): Promise<boolean> {
	const rows = await connection.query(
		`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
		[schema, table],
	);
	return rows.length === 1;
}

describe("an applied migration is history (E-08, checksum ledger)", () => {
	it("refuses the whole run and applies nothing further once a checksum has changed", async () => {
		const schema = freshSchema("velve_checksum");
		const plan = coreMigrations("email");
		await runMigrations({ driver: connection, schema, migrations: plan });

		const [initial, identity] = plan;
		if (initial === undefined || identity === undefined) {
			throw new Error("the shipped plan lost a migration");
		}
		const later: Migration = {
			version: 3,
			name: "later_step",
			sql: "CREATE TABLE velve.later_step (id uuid PRIMARY KEY DEFAULT gen_random_uuid());",
		};

		await expect(
			runMigrations({
				driver: connection,
				schema,
				migrations: [{ ...initial, sql: `${initial.sql}-- edited\n` }, identity, later],
			}),
		).rejects.toMatchObject({ code: "migration_checksum_changed" });

		expect(await ledgerVersions(schema)).toEqual([1, 2]);
		expect(await tableExists(schema, "later_step")).toBe(false);
	});

	it("notices an edit that only reorders whitespace", async () => {
		const schema = freshSchema("velve_whitespace");
		const plan = coreMigrations("email");
		await runMigrations({ driver: connection, schema, migrations: plan });

		const [initial, identity] = plan;
		if (initial === undefined || identity === undefined) {
			throw new Error("the shipped plan lost a migration");
		}

		await expect(
			runMigrations({
				driver: connection,
				schema,
				migrations: [
					{ ...initial, sql: initial.sql.replace("CREATE SCHEMA", "CREATE  SCHEMA") },
					identity,
				],
			}),
		).rejects.toMatchObject({ code: "migration_checksum_changed" });
	});

	it("records the same checksum whatever the schema is named", async () => {
		const first = freshSchema("velve_name_a");
		const second = freshSchema("velve_name_b");
		await runMigrations({ driver: connection, schema: first, migrations: coreMigrations("email") });
		await runMigrations({
			driver: connection,
			schema: second,
			migrations: coreMigrations("email"),
		});

		const checksums = await Promise.all(
			[first, second].map(async (schema) => {
				const rows = await connection.query<{ checksum: string }>(
					`SELECT checksum FROM ${schema}.schema_migration ORDER BY version`,
					[],
				);
				return rows.map((row) => row.checksum);
			}),
		);

		expect(checksums[0]).toEqual(checksums[1]);
	});
});

describe("a migration that fails halfway (E-08, one transaction per step)", () => {
	it("leaves neither the tables it created nor a ledger row", async () => {
		const schema = freshSchema("velve_halfway");
		const failing: Migration = {
			version: 3,
			name: "half_applied",
			sql: `CREATE TABLE velve.half_applied_first (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE velve.half_applied_second (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
SELECT 1 / 0;`,
		};

		await expect(
			runMigrations({
				driver: connection,
				schema,
				migrations: [...coreMigrations("email"), failing],
			}),
		).rejects.toThrow();

		expect(await tableExists(schema, "half_applied_first")).toBe(false);
		expect(await tableExists(schema, "half_applied_second")).toBe(false);
		expect(await ledgerVersions(schema)).toEqual([1, 2]);
	});

	it("keeps the steps that completed before the failing one", async () => {
		const schema = freshSchema("velve_partial_plan");
		const good: Migration = {
			version: 3,
			name: "good_step",
			sql: "CREATE TABLE velve.good_step (id uuid PRIMARY KEY DEFAULT gen_random_uuid());",
		};
		const bad: Migration = {
			version: 4,
			name: "bad_step",
			sql: "CREATE TABLE velve.bad_step (id uuid PRIMARY KEY DEFAULT gen_random_uuid()); SELECT 1 / 0;",
		};

		await expect(
			runMigrations({
				driver: connection,
				schema,
				migrations: [...coreMigrations("email"), good, bad],
			}),
		).rejects.toThrow();

		expect(await tableExists(schema, "good_step")).toBe(true);
		expect(await tableExists(schema, "bad_step")).toBe(false);
		expect(await ledgerVersions(schema)).toEqual([1, 2, 3]);
	});
});

describe("renaming the schema rewrites only the schema (finding: it rewrites the word)", () => {
	it("leaves a string literal that happens to read velve alone", async () => {
		const schema = freshSchema("velve_literal");
		const literal: Migration = {
			version: 3,
			name: "literal_step",
			sql: `CREATE TABLE velve.literal_step (source text NOT NULL);
INSERT INTO velve.literal_step (source) VALUES ('velve');`,
		};

		await runMigrations({
			driver: connection,
			schema,
			migrations: [...coreMigrations("email"), literal],
		});

		const [row] = await connection.query<{ source: string }>(
			`SELECT source FROM ${schema}.literal_step`,
			[],
		);
		expect(row?.source).toBe("velve");
	});

	it("leaves a column that happens to be named velve alone", async () => {
		const schema = freshSchema("velve_column");
		const named: Migration = {
			version: 3,
			name: "named_step",
			sql: "CREATE TABLE velve.named_step (velve text NOT NULL);",
		};

		await runMigrations({
			driver: connection,
			schema,
			migrations: [...coreMigrations("email"), named],
		});

		const rows = await connection.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_schema = $1 AND table_name = 'named_step'`,
			[schema],
		);
		expect(rows.map((row) => row.column_name)).toEqual(["velve"]);
	});
});
