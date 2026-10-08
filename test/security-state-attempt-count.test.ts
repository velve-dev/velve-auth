import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pendingBinding } from "../src/core/factor/pending/binding.js";
import { bookAttemptOn } from "../src/core/factor/pending/booking.js";
import {
	createPendingAuthenticationService,
	MAXIMUM_PENDING_ATTEMPTS,
	type PendingAuthenticationService,
	type PendingToken,
} from "../src/core/factor/pending/index.js";
import { hashPendingToken } from "../src/core/factor/pending/token.js";
import { bindToken, type TokenBindingRefusal } from "../src/core/token/binding.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { failOneAttempt, testKeyRing } from "./totp-fixtures.js";

//a row a writer changes while a booking waits on it must answer as missing with the alarm unless a booking moved it (E-3208)

let owner: TestConnection;
let writer: TestConnection;
//a transaction keeps its first view of pg_stat_activity, so the wait is watched from outside it
let observer: TestConnection;
let schema: string;
let refusals: TokenBindingRefusal[];
let pending: PendingAuthenticationService;
//three versions, so a row can be rebound under a newer or an older one while a booking waits on it
const ring = testKeyRing(3);

beforeAll(async () => {
	const migrated = await openMigratedSchema("review_attempt_carry");
	owner = migrated.connection;
	schema = migrated.schema;
	writer = await openTestConnection();
	observer = await openTestConnection();
	pending = createPendingAuthenticationService({
		driver: owner,
		keys: ring.providerAt(2, [1, 2, 3]),
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
		await failOneAttempt(pending, token);
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
	const booking = bookAttemptOn(pending, token);
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
		await failOneAttempt(pending, token);
		await failOneAttempt(pending, token);
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

describe("a booked attempt and a legitimate rebinding during the booking (E-3149)", () => {
	it("re-pins to the row rebound at an equal count under a newer version, without an alarm", async () => {
		const userId = await createUser(owner, schema);
		const older = createPendingAuthenticationService({
			driver: owner,
			keys: ring.providerAt(1, [1]),
			schema,
		});
		const { token } = await older.begin({ userId, factorsCompleted: ["password"] });
		const rebound = await bindToken(
			ring.providerAt(2, [1, 2]),
			pendingBinding(userId, hashPendingToken(token), ["password"], 0),
		);
		refusals = [];

		const outcome = await bookingWhileTheWriter(userId, token, async () => {
			await writer.query(
				`UPDATE ${schema}.pending_authentication
				 SET token_mac = $2, token_mac_key_version = $3 WHERE user_id = $1`,
				[userId, rebound.tokenMac, rebound.tokenMacKeyVersion],
			);
		});

		expect(outcome).toBe("booked");
		expect(await attemptsOf(userId)).toBe(1);
		expect(refusals).toStrictEqual([]);
	});
});

describe("a booked attempt and a rewrite that only looks like progress (section 3.18 point 3)", () => {
	it("treats the row as missing, with the alarm, when it is rebound at an equal count under an older version", async () => {
		const userId = await createUser(owner, schema);
		const token = await pendingAfterFailedAttempts(userId, 1);
		const older = await bindToken(
			ring.providerAt(1, [1]),
			pendingBinding(userId, hashPendingToken(token), ["password"], 1),
		);
		refusals = [];

		const outcome = await bookingWhileTheWriter(userId, token, async () => {
			await writer.query(
				`UPDATE ${schema}.pending_authentication
				 SET token_mac = $2, token_mac_key_version = $3 WHERE user_id = $1`,
				[userId, older.tokenMac, older.tokenMacKeyVersion],
			);
		});

		expect(outcome).toBe("missing");
		expect(refusals).toStrictEqual([
			{ userId, occasion: "factor_check", reason: "token_binding_mismatch", verdict: "mismatch" },
		]);
	});

	it("reports the verdict the re-read found, not a mismatch in its place", async () => {
		const userId = await createUser(owner, schema);
		const token = await pendingAfterFailedAttempts(userId, 1);
		refusals = [];

		const outcome = await bookingWhileTheWriter(userId, token, async () => {
			await writer.query(
				`UPDATE ${schema}.pending_authentication
				 SET token_mac = $2, token_mac_key_version = 99 WHERE user_id = $1`,
				[userId, new Uint8Array(32).fill(3)],
			);
		});

		expect(outcome).toBe("missing");
		expect(refusals.map((refusal) => refusal.verdict)).toStrictEqual(["key_version_unknown"]);
	});

	it("treats a row that expired during the booking as missing, without an alarm", async () => {
		const userId = await createUser(owner, schema);
		const token = await pendingAfterFailedAttempts(userId, 1);
		refusals = [];

		const outcome = await bookingWhileTheWriter(userId, token, async () => {
			await writer.query(
				`UPDATE ${schema}.pending_authentication SET expires_at = now() - interval '1 second'
				 WHERE user_id = $1`,
				[userId],
			);
		});

		expect(outcome).toBe("missing");
		expect(await attemptsOf(userId)).toBe(1);
		expect(refusals).toStrictEqual([]);
	});

	it("follows a row rebound at the same count under every newer version of the ring, without an alarm", async () => {
		const many = testKeyRing(MAXIMUM_PENDING_ATTEMPTS + 3);
		const newest = MAXIMUM_PENDING_ATTEMPTS + 3;
		const userId = await createUser(owner, schema);
		const { token } = await createPendingAuthenticationService({
			driver: owner,
			keys: many.providerAt(1),
			schema,
		}).begin({ userId, factorsCompleted: ["password"] });
		let interposed = 0;
		const rebindingBeforeEveryBooking: typeof owner = {
			...owner,
			query: async (sql, params) => {
				if (sql.includes("SET attempts =") && interposed + 1 < newest) {
					interposed += 1;
					const next = await bindToken(
						many.providerAt(interposed + 1),
						pendingBinding(userId, hashPendingToken(token), ["password"], 0),
					);
					await owner.query(
						`UPDATE ${schema}.pending_authentication
						 SET token_mac = $2, token_mac_key_version = $3 WHERE user_id = $1`,
						[userId, next.tokenMac, next.tokenMacKeyVersion],
					);
				}
				return owner.query(sql, params);
			},
		};
		refusals = [];

		const booked = await bookAttemptOn(
			createPendingAuthenticationService({
				driver: rebindingBeforeEveryBooking,
				keys: many.providerAt(newest),
				schema,
				reportTokenBindingRefusal: (refusal) => refusals.push(refusal),
			}),
			token,
		);

		expect({
			outcome: booked.outcome,
			interposed,
			attempts: await attemptsOf(userId),
			refusals,
		}).toStrictEqual({
			outcome: "booked",
			interposed: newest - 1,
			attempts: 1,
			refusals: [],
		});
	});
});

describe("a writer who edits the row while a booking waits on it, to launder it through the booking", () => {
	it("does not get a valid MAC over factors he chose, however many attempts he claims", async () => {
		const userId = await createUser(owner, schema);
		const token = await pendingAfterFailedAttempts(userId, 1);
		refusals = [];

		const outcome = await bookingWhileTheWriter(userId, token, async () => {
			await writer.query(
				`UPDATE ${schema}.pending_authentication
				 SET attempts = 3, factors_completed = '{password,totp}' WHERE user_id = $1`,
				[userId],
			);
		});
		const [row] = await owner.query<{ factors: string }>(
			`SELECT array_to_string(factors_completed, ',') AS factors
			 FROM ${schema}.pending_authentication WHERE user_id = $1`,
			[userId],
		);

		expect(outcome).toBe("missing");
		expect(refusals.map((refusal) => refusal.reason)).toStrictEqual(["token_binding_mismatch"]);
		expect(await pending.resolve(token)).toBeNull();
		expect(row?.factors).toBe("password,totp");
	});

	it("is refused as missing, with the alarm, when the rewritten row is at the budget", async () => {
		const userId = await createUser(owner, schema);
		const token = await pendingAfterFailedAttempts(userId, 1);
		refusals = [];

		const outcome = await bookingWhileTheWriter(userId, token, async () => {
			await writer.query(
				`UPDATE ${schema}.pending_authentication SET attempts = ${MAXIMUM_PENDING_ATTEMPTS}
				 WHERE user_id = $1`,
				[userId],
			);
		});

		expect(outcome).toBe("missing");
		expect(refusals.map((refusal) => refusal.reason)).toStrictEqual(["token_binding_mismatch"]);
	});
});
