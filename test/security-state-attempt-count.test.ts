import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createPendingAuthenticationService,
	MAXIMUM_PENDING_ATTEMPTS,
	type PendingAuthenticationService,
	type PendingToken,
} from "../src/core/factor/pending/index.js";
import { hashPendingToken } from "../src/core/factor/pending/token.js";
import type { TokenBindingRefusal } from "../src/core/token/binding.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { testKeyProvider } from "./totp-fixtures.js";

// A writer who holds a pending row changes it while a booked attempt waits on the row lock.
// Section 3.18 point 3 makes the booking conditional on the attempts value and the MAC the
// resolution verified; a booking that misses reads the row once more and refuses it as missing,
// with the alarm, when it is not a concurrent attempt's progress (E-3194, E-3140).

let owner: TestConnection;
let writer: TestConnection;
//a transaction keeps its first view of pg_stat_activity, so the wait is watched from outside it
let observer: TestConnection;
let schema: string;
let refusals: TokenBindingRefusal[];
let pending: PendingAuthenticationService;

beforeAll(async () => {
	const migrated = await openMigratedSchema("review_attempt_carry");
	owner = migrated.connection;
	schema = migrated.schema;
	writer = await openTestConnection();
	observer = await openTestConnection();
	pending = createPendingAuthenticationService({
		driver: owner,
		keys: testKeyProvider(),
		schema,
		reportTokenBindingRefusal: (refusal) => refusals.push(refusal),
	});
});

afterAll(async () => {
	await dropSchema(owner, schema);
	await owner.close();
	await writer.close();
	await observer.close();
});

async function untilBookingWaitsOnTheRow(): Promise<void> {
	for (let poll = 0; poll < 200; poll += 1) {
		const [row] = await observer.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM pg_stat_activity
			 WHERE wait_event_type = 'Lock' AND query LIKE '%pending_authentication%SET attempts =%'`,
			[],
		);
		if ((row?.n ?? 0) > 0) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("the booking never waited on the writer's row lock");
}

async function pendingAfterFailedAttempts(userId: string, failed: number): Promise<PendingToken> {
	const { token } = await pending.begin({ userId, factorsCompleted: ["password"] });
	for (let attempt = 0; attempt < failed; attempt += 1) {
		await pending.registerFailedAttempt(token);
	}
	return token;
}

async function bookingWhileTheWriter(
	userId: string,
	token: PendingToken,
	change: () => Promise<void>,
): Promise<string> {
	await writer.query("BEGIN", []);
	await writer.query(
		`SELECT 1 FROM ${schema}.pending_authentication WHERE user_id = $1 FOR UPDATE`,
		[userId],
	);
	const booking = pending.bookAttempt(token);
	await untilBookingWaitsOnTheRow();
	await change();
	await writer.query("COMMIT", []);
	return (await booking).outcome;
}

async function attemptsOf(userId: string): Promise<number | undefined> {
	const [row] = await owner.query<{ attempts: number }>(
		`SELECT attempts FROM ${schema}.pending_authentication WHERE user_id = $1`,
		[userId],
	);
	return row?.attempts;
}

describe("a booked attempt and a writer who changes the row during the booking", () => {
	it("treats the row as missing instead of counting on from a reset counter", async () => {
		const userId = await createUser(owner, schema);
		const token = await pendingAfterFailedAttempts(userId, MAXIMUM_PENDING_ATTEMPTS - 2);
		refusals = [];

		const outcome = await bookingWhileTheWriter(userId, token, async () => {
			await writer.query(
				`UPDATE ${schema}.pending_authentication SET attempts = 0 WHERE user_id = $1`,
				[userId],
			);
		});

		expect(outcome).toBe("missing");
		expect(await attemptsOf(userId)).toBe(0);
		expect(refusals.map((refusal) => refusal.reason)).toStrictEqual(["token_binding_mismatch"]);
		expect(await pending.resolve(token)).toBeNull();
	});

	it("treats the row as missing when the writer restores an older consistent version", async () => {
		const userId = await createUser(owner, schema);
		const token = await pendingAfterFailedAttempts(userId, 1);
		const [older] = await owner.query<{ mac: Buffer; version: number }>(
			`SELECT token_mac AS mac, token_mac_key_version AS version
			 FROM ${schema}.pending_authentication WHERE token_sha256 = $1`,
			[hashPendingToken(token)],
		);
		await pending.registerFailedAttempt(token);
		await pending.registerFailedAttempt(token);
		refusals = [];

		const outcome = await bookingWhileTheWriter(userId, token, async () => {
			await writer.query(
				`UPDATE ${schema}.pending_authentication
				 SET attempts = 1, token_mac = $2, token_mac_key_version = $3 WHERE user_id = $1`,
				[userId, older?.mac, older?.version],
			);
		});

		expect(outcome).toBe("missing");
		expect(await attemptsOf(userId)).toBe(1);
		expect(refusals.map((refusal) => refusal.reason)).toStrictEqual(["token_binding_mismatch"]);
	});
});
