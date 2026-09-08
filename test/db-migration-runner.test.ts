import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MigrationRefusedError, runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

const schema = `velve_runner_${randomBytes(6).toString("hex")}`;
let connection: TestConnection;

beforeAll(async () => {
	connection = await openTestConnection();
});

afterAll(async () => {
	await connection.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, []);
	await connection.close();
});

async function tableNames(): Promise<string[]> {
	const rows = await connection.query<{ table_name: string }>(
		"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
		[schema],
	);
	return rows.map((row) => row.table_name);
}

describe("migration runner", () => {
	it("applies the shipped plan into a schema of the configured name", async () => {
		const report = await runMigrations({
			driver: connection,
			schema,
			migrations: coreMigrations("username_email"),
		});

		expect(report.appliedVersions).toEqual([1, 2]);
		expect(report.currentVersion).toBe(2);
		expect(await tableNames()).toHaveLength(16);
	});

	it("applies nothing on a second run", async () => {
		const report = await runMigrations({
			driver: connection,
			schema,
			migrations: coreMigrations("username_email"),
		});

		expect(report.appliedVersions).toEqual([]);
		expect(report.currentVersion).toBe(2);
	});

	it("records name and checksum for every applied migration", async () => {
		const ledger = await connection.query<{ version: number; name: string; checksum: string }>(
			`SELECT version, name, checksum FROM ${schema}.schema_migration ORDER BY version`,
			[],
		);

		expect(ledger.map((row) => [row.version, row.name])).toEqual([
			[1, "initial_schema"],
			[2, "identity_username_email"],
		]);
		for (const row of ledger) {
			expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
		}
	});

	it("refuses to run when an applied migration's checksum has changed", async () => {
		const [initial, identity] = coreMigrations("username_email");
		if (initial === undefined || identity === undefined) {
			throw new Error("the shipped plan lost a migration");
		}

		await expect(
			runMigrations({
				driver: connection,
				schema,
				migrations: [{ ...initial, sql: `${initial.sql}\n-- edited after the fact` }, identity],
			}),
		).rejects.toMatchObject({ code: "migration_checksum_changed" });
	});

	it("refuses a plan in which two migrations claim the same version", async () => {
		await expect(
			runMigrations({
				driver: connection,
				schema,
				migrations: [
					{ version: 7, name: "first", sql: "SELECT 1" },
					{ version: 7, name: "second", sql: "SELECT 1" },
				],
			}),
		).rejects.toBeInstanceOf(MigrationRefusedError);
	});

	it("applies each migration exactly once when two runners start together", async () => {
		const concurrentSchema = `velve_race_${randomBytes(6).toString("hex")}`;
		const runners = await Promise.all([openTestConnection(), openTestConnection()]);
		try {
			const reports = await Promise.all(
				runners.map((driver) =>
					runMigrations({ driver, schema: concurrentSchema, migrations: coreMigrations("email") }),
				),
			);

			expect(reports.flatMap((report) => report.appliedVersions).sort()).toEqual([1, 2]);
			for (const report of reports) {
				expect(report.currentVersion).toBe(2);
			}
		} finally {
			await connection.query(`DROP SCHEMA IF EXISTS ${concurrentSchema} CASCADE`, []);
			await Promise.all(runners.map((runner) => runner.close()));
		}
	});
});
