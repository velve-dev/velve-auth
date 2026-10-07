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
	it("locks the four token tables before it deletes anything", () => {
		const statements = tokenMacSchema.sql
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.split(";")
			.map((statement) => statement.replace(/\s+/g, " ").trim())
			.filter((statement) => statement.length > 0);

		expect(statements.slice(0, 5)).toStrictEqual([
			"LOCK TABLE velve.pending_authentication IN ACCESS EXCLUSIVE MODE",
			"LOCK TABLE velve.one_time_token IN ACCESS EXCLUSIVE MODE",
			"LOCK TABLE velve.webauthn_challenge IN ACCESS EXCLUSIVE MODE",
			"LOCK TABLE velve.session IN ACCESS EXCLUSIVE MODE",
			"DELETE FROM velve.session",
		]);
	});

	it("signs every user out and leaves the four tables with the MAC columns", async () => {
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
		await connection.query(
			`INSERT INTO ${schema}.webauthn_challenge (challenge_sha256, purpose, user_id, expires_at)
			 VALUES ($1, 'register', $2, now() + interval '5 minutes')`,
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
			await rowsIn("webauthn_challenge"),
		]).toEqual([0, 0, 0, 0]);
		expect(columns.map((column) => `${column.table_name}.${column.column_name}`)).toEqual([
			"one_time_token.token_mac",
			"one_time_token.token_mac_key_version",
			"pending_authentication.token_mac",
			"pending_authentication.token_mac_key_version",
			"session.token_mac",
			"session.token_mac_key_version",
			"webauthn_challenge.token_mac",
			"webauthn_challenge.token_mac_key_version",
		]);
	});
});

//a 1.x transaction holds the first table and is about to insert a session when the migration starts
const FLOWS_IN_FLIGHT: readonly [string, string, string][] = [
	[
		"a second-factor completion",
		"pending_authentication",
		`DELETE FROM %s.pending_authentication WHERE user_id = $1`,
	],
	["a password reset", "one_time_token", `DELETE FROM %s.one_time_token WHERE user_id = $1`],
];

describe("migration 4 against a 1.x sign-in in flight", () => {
	let completion: TestConnection;
	let observer: TestConnection;

	beforeAll(async () => {
		completion = await openTestConnection();
		observer = await openTestConnection();
	});

	afterAll(async () => {
		await completion.close();
		await observer.close();
	});

	async function untilTheMigrationWaits(): Promise<void> {
		for (let poll = 0; poll < 300; poll += 1) {
			const [row] = await observer.query<{ n: number }>(
				`SELECT count(*)::int AS n FROM pg_stat_activity
				 WHERE wait_event_type = 'Lock' AND query LIKE '%LOCK TABLE%'`,
				[],
			);
			if ((row?.n ?? 0) > 0) {
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error("the migration never waited on the sign-in's lock");
	}

	it.each(FLOWS_IN_FLIGHT)(
		"waits for %s and is not the transaction a deadlock aborts",
		async (_flow, _table, firstStatement) => {
			const flowSchema = uniqueSchemaName("token_mac_lock_order");
			await runMigrations({
				driver: connection,
				schema: flowSchema,
				migrations: coreMigrations("email").filter((migration) => migration.version < 4),
			});
			try {
				const userId = await createUser(connection, flowSchema);
				await connection.query(
					`INSERT INTO ${flowSchema}.pending_authentication
					   (token_sha256, user_id, factors_completed, expires_at)
					 VALUES ($1, $2, '{password}', now() + interval '5 minutes')`,
					[randomBytes(32), userId],
				);
				await connection.query(
					`INSERT INTO ${flowSchema}.one_time_token (token_sha256, purpose, user_id, expires_at)
					 VALUES ($1, 'password_reset', $2, now() + interval '1 hour')`,
					[randomBytes(32), userId],
				);

				await completion.query("BEGIN", []);
				await completion.query(firstStatement.replace("%s", flowSchema), [userId]);
				const migrating = runMigrations({
					driver: connection,
					schema: flowSchema,
					migrations: coreMigrations("email"),
				})
					.then((report) => report.appliedVersions)
					.catch((failure: unknown) => `failed: ${(failure as Error).message}`);
				await untilTheMigrationWaits();
				const inserted = await completion
					.query(
						`INSERT INTO ${flowSchema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at)
						 VALUES ($1, $2, now() + interval '1 day', now() + interval '2 days')`,
						[userId, randomBytes(32)],
					)
					.then(() => "inserted")
					.catch((failure: unknown) => `failed: ${(failure as Error).message}`);
				await completion.query("COMMIT", []).catch(() => undefined);
				const migrated = await migrating;

				expect({ migrated, inserted }).toStrictEqual({ migrated: [4], inserted: "inserted" });
				expect(await rowsInSchema(flowSchema, "session")).toBe(0);
			} finally {
				await completion.query("ROLLBACK", []).catch(() => undefined);
				await dropSchema(connection, flowSchema);
			}
		},
		30_000,
	);
});

async function rowsInSchema(target: string, table: string): Promise<number> {
	const [row] = await connection.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM ${target}.${table}`,
		[],
	);
	return row?.n ?? -1;
}
