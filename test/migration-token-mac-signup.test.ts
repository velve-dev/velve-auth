import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import { createUser, dropSchema, uniqueSchemaName } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

//migration 4 may deadlock with a 1.x sign-up still in flight, and then a rerun completes it with nothing stranded (E-3279)

let connection: TestConnection;
let signUp: TestConnection;
let observer: TestConnection;

beforeAll(async () => {
	connection = await openTestConnection();
	signUp = await openTestConnection();
	observer = await openTestConnection();
});

afterAll(async () => {
	await signUp.close();
	await observer.close();
	await connection.close();
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
	throw new Error("the migration never waited");
}

const DEADLOCK_DETECTED = "40P01";

function isDeadlock(side: unknown): boolean {
	if (typeof side !== "object" || side === null || Array.isArray(side)) {
		return false;
	}
	const fields = side as { readonly sqlState?: unknown; readonly code?: unknown };
	return (fields.sqlState ?? fields.code) === DEADLOCK_DETECTED;
}

describe("migration 4 against a 1.x sign-up in flight", () => {
	it("deadlocks, and the migration run again applies with every token table in its new form", async () => {
		const schema = uniqueSchemaName("migration_token_mac_signup");
		await runMigrations({
			driver: connection,
			schema,
			migrations: coreMigrations("email").filter((migration) => migration.version < 4),
		});
		try {
			const userId = await createUser(connection, schema);
			await signUp.query("BEGIN", []);
			await signUp.query(
				`INSERT INTO ${schema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at)
				 VALUES ($1, $2, now() + interval '1 day', now() + interval '2 days')`,
				[userId, randomBytes(32)],
			);
			const migrating = runMigrations({
				driver: connection,
				schema,
				migrations: coreMigrations("email"),
			})
				.then((report) => report.appliedVersions)
				.catch((failure: unknown) => failure as { sqlState?: string; code?: string });
			await untilTheMigrationWaits();
			const minted = await signUp
				.query(
					`INSERT INTO ${schema}.one_time_token (token_sha256, purpose, user_id, expires_at)
					 VALUES ($1, 'email_verify', $2, now() + interval '1 hour')`,
					[randomBytes(32), userId],
				)
				.then(() => "minted")
				.catch((failure: unknown) => failure as { sqlState?: string; code?: string });
			await signUp.query("COMMIT", []).catch(() => undefined);
			await signUp.query("ROLLBACK", []).catch(() => undefined);
			const first = await migrating;
			const deadlocked = [first, minted].filter(isDeadlock);
			const rerun = await runMigrations({
				driver: connection,
				schema,
				migrations: coreMigrations("email"),
			});
			const columns = await connection.query<{ table_name: string }>(
				`SELECT table_name FROM information_schema.columns
				 WHERE table_schema = $1 AND column_name = 'token_mac' ORDER BY table_name`,
				[schema],
			);

			expect(deadlocked).toHaveLength(1);
			expect(Array.isArray(first) ? first : rerun.appliedVersions).toStrictEqual([4]);
			expect(columns.map((column) => column.table_name)).toStrictEqual([
				"one_time_token",
				"pending_authentication",
				"session",
				"webauthn_challenge",
			]);
		} finally {
			await signUp.query("ROLLBACK", []).catch(() => undefined);
			await dropSchema(connection, schema);
		}
	}, 30_000);
});
