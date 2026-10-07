import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockAccountRowStatement } from "../src/core/db/lock.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

// Section 3.18 retries a sealing transaction on a serialization failure and on a unique violation
// of the first seal's insert. Two REPEATABLE READ transactions that first-seal one account do not
// meet as a serialization failure: the second waits on the lock, still reads no seal row in its
// snapshot, and its insert fails on the primary key. This case holds that premise; the sealing code
// that retries on it is the seal branch's (E-3210).

let first: TestConnection;
let second: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("first_seal_conflict");
	first = migrated.connection;
	schema = migrated.schema;
	second = await openTestConnection();
});

afterAll(async () => {
	await dropSchema(first, schema);
	await first.close();
	await second.close();
});

function sealInsert(connection: TestConnection, userId: string): Promise<unknown> {
	return connection.query(
		`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
		 VALUES ($1, 1, decode(repeat('00', 32), 'hex'), 1)`,
		[userId],
	);
}

describe("two first seals of one account (section 3.18, Sealing)", () => {
	it("fail the later one with a unique violation, not a serialization failure", async () => {
		const userId = await createUser(first, schema);
		await first.query("BEGIN ISOLATION LEVEL REPEATABLE READ", []);
		await second.query("BEGIN ISOLATION LEVEL REPEATABLE READ", []);
		try {
			await first.query(lockAccountRowStatement(schema), [userId]);
			await sealInsert(first, userId);
			const secondLock = second.query(lockAccountRowStatement(schema), [userId]);
			await first.query("COMMIT", []);
			await secondLock;
			const [seen] = await second.query<{ n: number }>(
				`SELECT count(*)::int AS n FROM ${schema}.security_state WHERE user_id = $1`,
				[userId],
			);
			const sqlState = await sealInsert(second, userId)
				.then(() => "inserted")
				.catch((error: { sqlState?: string; code?: string }) => error.sqlState ?? error.code);
			expect({ seen: seen?.n, sqlState }).toStrictEqual({ seen: 0, sqlState: "23505" });
		} finally {
			await first.query("ROLLBACK", []).catch(() => undefined);
			await second.query("ROLLBACK", []);
		}
	});
});
