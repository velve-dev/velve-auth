import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import { dropSchema, uniqueSchemaName } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

const RUNNERS = 8;
const REPETITIONS = 5;

let observer: TestConnection;

beforeAll(async () => {
	observer = await openTestConnection();
});

afterAll(async () => {
	await observer.close();
});

async function ledgerRows(schema: string): Promise<{ version: number; name: string }[]> {
	return observer.query<{ version: number; name: string }>(
		`SELECT version, name FROM ${schema}.schema_migration ORDER BY version`,
		[],
	);
}

describe("the advisory lock in the migration runner (E-08)", () => {
	it("lets exactly one runner apply each version when eight start against a fresh schema", async () => {
		for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
			const schema = uniqueSchemaName("velve_race");
			const connections = await Promise.all(
				Array.from({ length: RUNNERS }, () => openTestConnection()),
			);
			try {
				const reports = await Promise.all(
					connections.map((driver) =>
						runMigrations({ driver, schema, migrations: coreMigrations("email") }),
					),
				);

				const claimed = reports.flatMap((report) => report.appliedVersions).sort();
				expect(claimed).toEqual([1, 2]);
				expect(reports.map((report) => report.currentVersion)).toEqual(
					Array.from({ length: RUNNERS }, () => 2),
				);
				expect((await ledgerRows(schema)).map((row) => row.version)).toEqual([1, 2]);

				const [tables] = await observer.query<{ present: number }>(
					`SELECT count(*)::int AS present FROM information_schema.tables
					 WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
					[schema],
				);
				expect(tables?.present).toBe(16);
			} finally {
				await Promise.all(connections.map((connection) => connection.close()));
				await dropSchema(observer, schema);
			}
		}
	});

	it("does not serialise runners that migrate different schemas", async () => {
		const schemas = [uniqueSchemaName("velve_par_a"), uniqueSchemaName("velve_par_b")];
		const connections = await Promise.all(schemas.map(() => openTestConnection()));
		try {
			const reports = await Promise.all(
				connections.map((driver, index) =>
					runMigrations({
						driver,
						schema: schemas[index] ?? "",
						migrations: coreMigrations("email"),
					}),
				),
			);

			expect(reports.map((report) => report.appliedVersions)).toEqual([
				[1, 2],
				[1, 2],
			]);
		} finally {
			await Promise.all(connections.map((connection) => connection.close()));
			for (const schema of schemas) {
				await dropSchema(observer, schema);
			}
		}
	});
});
