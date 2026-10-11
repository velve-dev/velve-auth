import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, testKeyProvider } from "./auth-fixtures.js";
import { createUser, dropSchema, uniqueSchemaName } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

//the start probe reads no token mac version from a schema migration 4 has not reached (E-3480)

let connection: TestConnection;
const schema = uniqueSchemaName("keys_token_columns");

beforeAll(async () => {
	connection = await openTestConnection();
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

describe("migrate() on a schema at migration 3 that already holds a seal", () => {
	it("probes the seal, then applies migration 4", async () => {
		await runMigrations({
			driver: connection,
			schema,
			migrations: coreMigrations("email").filter((migration) => migration.version < 4),
		});
		const userId = await createUser(connection, schema);
		await connection.query(
			`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
			 VALUES ($1, 1, decode(repeat('00', 32), 'hex'), 1)`,
			[userId],
		);

		const report = await createVelveAuth(
			configFor({ database: connection, schema, keys: testKeyProvider() }),
		).migrate();

		expect(report.appliedVersions).toStrictEqual([4]);
	});
});
