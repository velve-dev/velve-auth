import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import { tokenMacSchema } from "../src/core/db/migrations/token-mac.js";
import { createUser, dropSchema, uniqueSchemaName } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

/**
 * Migration 4 (section 3.18 point 3, E-3086): no row written before it carries a token MAC, so it
 * deletes every session, one-time token and pending authentication before it adds the NOT NULL
 * columns, after locking the three tables against a 1.x instance still inserting (E-3146).
 */

let connection: TestConnection;
let schema: string;

beforeAll(async () => {
	connection = await openTestConnection();
	schema = uniqueSchemaName("token_mac_migration");
	const beforeMigrationFour = coreMigrations("email").filter((migration) => migration.version < 4);
	await runMigrations({ driver: connection, schema, migrations: beforeMigrationFour });
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

async function rowsIn(table: string): Promise<number> {
	const [row] = await connection.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM ${schema}.${table}`,
		[],
	);
	return row?.n ?? -1;
}

describe("migration 4, the token MAC columns", () => {
	it("locks the three token tables before it deletes anything", () => {
		const statements = tokenMacSchema.sql
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.split(";")
			.map((statement) => statement.replace(/\s+/g, " ").trim())
			.filter((statement) => statement.length > 0);

		expect(statements[0]).toBe(
			"LOCK TABLE velve.session, velve.one_time_token, velve.pending_authentication IN ACCESS EXCLUSIVE MODE",
		);
		expect(statements[1]).toBe("DELETE FROM velve.session");
	});

	it("signs every user out and leaves the three tables with the MAC columns", async () => {
		const userId = await createUser(connection, schema);
		await connection.query(
			`INSERT INTO ${schema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at)
			 VALUES ($1, $2, now() + interval '1 day', now() + interval '2 days')`,
			[userId, randomBytes(32)],
		);
		await connection.query(
			`INSERT INTO ${schema}.one_time_token (token_sha256, purpose, user_id, expires_at)
			 VALUES ($1, 'magic_link', $2, now() + interval '1 hour')`,
			[randomBytes(32), userId],
		);
		await connection.query(
			`INSERT INTO ${schema}.pending_authentication
			   (token_sha256, user_id, factors_completed, expires_at)
			 VALUES ($1, $2, '{password}', now() + interval '5 minutes')`,
			[randomBytes(32), userId],
		);

		const report = await runMigrations({
			driver: connection,
			schema,
			migrations: coreMigrations("email"),
		});
		const columns = await connection.query<{ table_name: string; column_name: string }>(
			`SELECT table_name, column_name FROM information_schema.columns
			 WHERE table_schema = $1 AND column_name IN ('token_mac', 'token_mac_key_version')
			 ORDER BY table_name, column_name`,
			[schema],
		);

		expect(report.appliedVersions).toEqual([4]);
		expect([
			await rowsIn("session"),
			await rowsIn("one_time_token"),
			await rowsIn("pending_authentication"),
		]).toEqual([0, 0, 0]);
		expect(columns.map((column) => `${column.table_name}.${column.column_name}`)).toEqual([
			"one_time_token.token_mac",
			"one_time_token.token_mac_key_version",
			"pending_authentication.token_mac",
			"pending_authentication.token_mac_key_version",
			"session.token_mac",
			"session.token_mac_key_version",
		]);
	});
});
