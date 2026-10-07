import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAXIMUM_PENDING_ATTEMPTS } from "../src/core/factor/pending/index.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { beginPendingState, pendingAuthenticationsOn } from "./totp-fixtures.js";

// A writer who holds a pending row sets attempts to 0 while a counted failed attempt waits on it.
// Section 3.18 point 3 makes the count conditional on the attempts value and the MAC the
// resolution verified, so the count misses and the row counts as missing. The count is built on
// the token branch (security-state-tokens), where the verified values reach the count through
// resolveForAttempt (E-3194, E-3139).

let owner: TestConnection;
let writer: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("review_attempt_carry");
	owner = migrated.connection;
	schema = migrated.schema;
	writer = await openTestConnection();
});

afterAll(async () => {
	await dropSchema(owner, schema);
	await owner.close();
	await writer.close();
});

async function untilCountWaitsOnTheRow(): Promise<void> {
	for (let poll = 0; poll < 200; poll += 1) {
		const [row] = await writer.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM pg_stat_activity
			 WHERE wait_event_type = 'Lock' AND query LIKE '%pending_authentication%SET attempts =%'`,
			[],
		);
		if ((row?.n ?? 0) > 0) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("the count never waited on the writer's row lock");
}

describe("a counted attempt and a writer who resets the counter during the count", () => {
	it("treats the row as missing instead of counting on from the reset", async () => {
		const userId = await createUser(owner, schema);
		const pending = pendingAuthenticationsOn(owner, schema);
		const { token } = await beginPendingState(pending, userId);
		for (let attempt = 1; attempt < MAXIMUM_PENDING_ATTEMPTS - 1; attempt += 1) {
			await (await pending.resolveForAttempt(token))?.registerFailedAttempt();
		}
		const resolved = await pending.resolveForAttempt(token);

		await writer.query("BEGIN", []);
		await writer.query(
			`SELECT 1 FROM ${schema}.pending_authentication WHERE user_id = $1 FOR UPDATE`,
			[userId],
		);
		const counted = resolved?.registerFailedAttempt();
		await untilCountWaitsOnTheRow();
		await writer.query(
			`UPDATE ${schema}.pending_authentication SET attempts = 0 WHERE user_id = $1`,
			[userId],
		);
		await writer.query("COMMIT", []);

		expect(await counted).toStrictEqual({ outcome: "exhausted" });
		const [row] = await owner.query<{ attempts: number }>(
			`SELECT attempts FROM ${schema}.pending_authentication WHERE user_id = $1`,
			[userId],
		);
		expect(row?.attempts).toBe(0);
		expect(await pending.resolve(token)).toBeNull();
	});
});
