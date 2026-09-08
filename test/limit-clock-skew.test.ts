import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RateLimiter } from "../src/core/http/rate-limit.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { limiterOn, type MovableClock, movableClock, readBuckets } from "./limit-fixtures.js";

const RULE = { capacity: 20, refillPerSecond: 0.01 };

/** Eleven and a half days backwards. E-381 chose the process clock over the database's `now()`,
 * which is what makes a step like this reachable at all: one instance whose clock is corrected,
 * or one container started from a wrong time, writes an `updated_at` the next check measures
 * from. Unfloored the refill term is −10,000 tokens; E-380's token floor catches the result at
 * −1, so what this floor actually saves is the whole remaining bucket and one refusal, not the
 * multi-day lockout the arithmetic first suggests (E-395). */
const BACKWARD_STEP_IN_SECONDS = 1_000_000;

let connection: TestConnection;
let schema: string;
let clock: MovableClock;
let limiter: RateLimiter;

beforeAll(async () => {
	const migrated = await openMigratedSchema("velve_rate_skew");
	connection = migrated.connection;
	schema = migrated.schema;
	clock = movableClock();
	limiter = limiterOn(connection, schema, clock);
}, 60_000);

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

async function draw(ipAddress: string): Promise<boolean> {
	const decision = await limiter.consume({
		routeName: "skew",
		rule: RULE,
		scope: { kind: "ip_address", ipAddress },
	});
	return decision.allowed;
}

async function levelOf(ipAddress: string): Promise<number> {
	const rows = await readBuckets(connection, schema);
	const row = rows.find((candidate) => candidate.bucket_key.endsWith(`|${ipAddress}/32`));
	if (row === undefined) {
		throw new Error(`no bucket for ${ipAddress}`);
	}
	return Number(row.tokens);
}

describe("a clock that steps backwards costs one token, not the whole bucket (S-RATE-7)", () => {
	it("draws one token across the step instead of ten thousand", async () => {
		const address = "198.51.100.21";
		expect(await draw(address)).toBe(true);
		const before = await levelOf(address);

		clock.advanceBySeconds(-BACKWARD_STEP_IN_SECONDS);
		expect(await draw(address)).toBe(true);

		expect(before).toBe(RULE.capacity - 1);
		expect(await levelOf(address)).toBe(before - 1);
	});

	it("leaves the rest of the capacity spendable, rather than a multi-day lockout", async () => {
		const address = "198.51.100.22";
		expect(await draw(address)).toBe(true);

		clock.advanceBySeconds(-BACKWARD_STEP_IN_SECONDS);

		let admitted = 0;
		for (let attempt = 0; attempt < RULE.capacity + 5; attempt += 1) {
			admitted += (await draw(address)) ? 1 : 0;
		}

		expect(admitted).toBe(RULE.capacity - 1);
		expect(await draw(address)).toBe(false);
	});

	it("still refills when the clock moves forwards", async () => {
		const address = "198.51.100.23";
		for (let attempt = 0; attempt < RULE.capacity; attempt += 1) {
			expect(await draw(address)).toBe(true);
		}
		expect(await draw(address)).toBe(false);

		clock.advanceBySeconds(RULE.capacity / RULE.refillPerSecond);

		expect(await draw(address)).toBe(true);
	});
});
