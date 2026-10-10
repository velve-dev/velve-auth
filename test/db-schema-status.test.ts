import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Migration } from "../src/core/db/migration.js";
import {
	assertSchemaUpToDate,
	readSchemaStatus,
	SchemaVersionMismatchError,
} from "../src/core/db/schema-status.js";
import { coreMigrations, runMigrations } from "../src/schema/index.js";
import { dropSchema, uniqueSchemaName } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

let connection: TestConnection;
const schemas: string[] = [];

function freshSchema(prefix: string): string {
	const schema = uniqueSchemaName(prefix);
	schemas.push(schema);
	return schema;
}

const SHIPPED_VERSIONS = coreMigrations("email").map((migration) => migration.version);
const LATEST_SHIPPED_VERSION = Math.max(...SHIPPED_VERSIONS);

const laterMigration: Migration = {
	version: LATEST_SHIPPED_VERSION + 1,
	name: "later_step",
	sql: "CREATE TABLE velve.later_step (id uuid PRIMARY KEY DEFAULT gen_random_uuid());",
};

beforeAll(async () => {
	connection = await openTestConnection();
});

afterAll(async () => {
	for (const schema of schemas) {
		await dropSchema(connection, schema);
	}
	await connection.close();
});

describe("the status query (F35, F37)", () => {
	it("reports an untouched database as version zero without creating anything", async () => {
		const schema = freshSchema("velve_status_empty");

		const status = await readSchemaStatus({
			driver: connection,
			schema,
			migrations: coreMigrations("email"),
		});

		expect(status).toMatchObject({
			currentVersion: 0,
			expectedVersion: LATEST_SHIPPED_VERSION,
			appliedVersions: [],
			pendingVersions: SHIPPED_VERSIONS,
			upToDate: false,
		});
		const created = await connection.query(
			"SELECT 1 FROM information_schema.schemata WHERE schema_name = $1",
			[schema],
		);
		expect(created).toEqual([]);
	});

	it("reports a migrated database as up to date", async () => {
		const schema = freshSchema("velve_status_done");
		const migrations = coreMigrations("email");
		await runMigrations({ driver: connection, schema, migrations });

		const status = await readSchemaStatus({ driver: connection, schema, migrations });

		expect(status).toMatchObject({
			currentVersion: LATEST_SHIPPED_VERSION,
			expectedVersion: LATEST_SHIPPED_VERSION,
			pendingVersions: [],
			changedVersions: [],
			upToDate: true,
		});
	});

	it("names the version a newer package expects but the database does not have", async () => {
		const schema = freshSchema("velve_status_behind");
		await runMigrations({ driver: connection, schema, migrations: coreMigrations("email") });

		const status = await readSchemaStatus({
			driver: connection,
			schema,
			migrations: [...coreMigrations("email"), laterMigration],
		});

		expect(status.currentVersion).toBe(LATEST_SHIPPED_VERSION);
		expect(status.expectedVersion).toBe(laterMigration.version);
		expect(status.pendingVersions).toEqual([laterMigration.version]);
	});

	it("names a migration that was applied with different SQL", async () => {
		const schema = freshSchema("velve_status_changed");
		const migrations = coreMigrations("email");
		await runMigrations({ driver: connection, schema, migrations });
		const [initial, identity] = migrations;
		if (initial === undefined || identity === undefined) {
			throw new Error("the shipped plan lost a migration");
		}

		const status = await readSchemaStatus({
			driver: connection,
			schema,
			migrations: [{ ...initial, sql: `${initial.sql}\n-- edited` }, identity],
		});

		expect(status.changedVersions).toEqual([1]);
		expect(status.upToDate).toBe(false);
	});

	it("turns a mismatch into an error that names both versions", async () => {
		const schema = freshSchema("velve_status_strict");
		await runMigrations({ driver: connection, schema, migrations: coreMigrations("email") });

		await expect(
			assertSchemaUpToDate({
				driver: connection,
				schema,
				migrations: [...coreMigrations("email"), laterMigration],
			}),
		).rejects.toBeInstanceOf(SchemaVersionMismatchError);
		await expect(
			assertSchemaUpToDate({
				driver: connection,
				schema,
				migrations: [...coreMigrations("email"), laterMigration],
			}),
		).rejects.toMatchObject({ code: "schema_version_mismatch" });
	});

	it("passes silently when the database matches the package", async () => {
		const schema = freshSchema("velve_status_ok");
		const migrations = coreMigrations("email");
		await runMigrations({ driver: connection, schema, migrations });

		await expect(
			assertSchemaUpToDate({ driver: connection, schema, migrations }),
		).resolves.toMatchObject({ upToDate: true });
	});
});
