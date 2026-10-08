import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rootKeyProvider } from "../src/core/keys/index.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { generateRootKey } from "./keys-fixtures.js";

//migrate fails on a deleted ledger row of migration 3 and changes no seal row (E-3288)

let connection: TestConnection;
let schema: string;

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("ledger_tamper"));
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

describe("T-INTEG-8: a deleted ledger row of migration 3", () => {
	it("migrate() fails after migration 3's ledger row is deleted and no seal row changes", async () => {
		const userId = await createUser(connection, schema);
		await connection.query(
			`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version, session_epoch)
VALUES ($1, 7, decode(repeat('ab', 32), 'hex'), 1, 3)`,
			[userId],
		);
		const before = await connection.query(
			`SELECT user_id, version::text, encode(digest,'hex') d, key_version, session_epoch::text, sealed_at FROM ${schema}.security_state`,
			[],
		);
		await connection.query(`DELETE FROM ${schema}.schema_migration WHERE version = 3`, []);

		const auth = createVelveAuth(
			configFor({
				database: connection,
				schema,
				keys: rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } }),
			}),
		);
		const outcome = await auth
			.migrate()
			.then(() => ({ sqlState: "none, migrate() succeeded", message: "" }))
			.catch((error: { sqlState?: string; message?: string }) => ({
				sqlState: error.sqlState ?? "no SQLSTATE",
				message: error.message ?? "",
			}));

		const after = await connection.query(
			`SELECT user_id, version::text, encode(digest,'hex') d, key_version, session_epoch::text, sealed_at FROM ${schema}.security_state`,
			[],
		);
		const ledger = await connection.query<{ version: number }>(
			`SELECT version FROM ${schema}.schema_migration ORDER BY version`,
			[],
		);
		expect(outcome).toStrictEqual({
			sqlState: "42P07",
			message: 'relation "security_state" already exists',
		});
		expect(ledger.map((row) => row.version)).toStrictEqual([1, 2, 4]);
		expect(after).toEqual(before);
	});
});
