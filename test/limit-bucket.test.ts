import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RateLimiter } from "../src/core/http/rate-limit.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { limiterOn, type MovableClock, movableClock, readBuckets } from "./limit-fixtures.js";

const CAPACITY = 20;
const RULE = { capacity: CAPACITY, refillPerSecond: 0.001 };
const ADDRESSES_PER_CASE = 1000;

let connection: TestConnection;
let schema: string;
let clock: MovableClock;
let limiter: RateLimiter;

beforeAll(async () => {
	const migrated = await openMigratedSchema("velve_rate_bucket");
	connection = migrated.connection;
	schema = migrated.schema;
	clock = movableClock();
	limiter = limiterOn(connection, schema, clock);
}, 60_000);

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

function hex(value: number): string {
	return value.toString(16);
}

function addressInOnePrefix(index: number): string {
	return `2001:db8::${hex(Math.floor(index / 256))}:${hex(index % 256)}`;
}

function addressInItsOwnPrefix(index: number): string {
	return `2001:db8:${hex(Math.floor(index / 256))}:${hex(index % 256)}::1`;
}

async function countAllowed(
	routeName: string,
	addresses: readonly string[],
): Promise<{ allowed: number; checks: number }> {
	let allowed = 0;
	let checks = 0;
	for (const ipAddress of addresses) {
		const decision = await limiter.consume({
			routeName,
			rule: RULE,
			scope: { kind: "ip_address", ipAddress },
		});
		checks += 1;
		allowed += decision.allowed ? 1 : 0;
	}
	return { allowed, checks };
}

describe("T-RATE-2 — one /64 is one bucket (S-RATE-2)", () => {
	it("admits exactly the capacity from a thousand addresses inside one prefix", async () => {
		const addresses = Array.from({ length: ADDRESSES_PER_CASE }, (_, index) =>
			addressInOnePrefix(index),
		);

		const counted = await countAllowed("oneprefix", addresses);

		expect(counted.checks).toBe(ADDRESSES_PER_CASE);
		expect(counted.allowed).toBe(CAPACITY);
		const rows = await readBuckets(connection, schema);
		expect(rows.filter((row) => row.bucket_key.startsWith("ip|oneprefix|"))).toHaveLength(1);
	}, 60_000);

	it("admits every one of a thousand addresses in a thousand prefixes", async () => {
		const addresses = Array.from({ length: ADDRESSES_PER_CASE }, (_, index) =>
			addressInItsOwnPrefix(index),
		);

		const counted = await countAllowed("manyprefixes", addresses);

		expect(counted.allowed).toBe(ADDRESSES_PER_CASE);
	}, 60_000);
});

describe("the bucket refills at the configured rate and nowhere near a lockout (S-RATE-7)", () => {
	const rule = { capacity: 4, refillPerSecond: 0.5 };

	async function draw(ipAddress: string): Promise<boolean> {
		const decision = await limiter.consume({
			routeName: "refill",
			rule,
			scope: { kind: "ip_address", ipAddress },
		});
		return decision.allowed;
	}

	it("lets a flood of refusals cost the next caller a bounded wait, not an unbounded one", async () => {
		for (let attempt = 0; attempt < rule.capacity; attempt += 1) {
			expect(await draw("198.51.100.7")).toBe(true);
		}
		for (let attempt = 0; attempt < 5000; attempt += 1) {
			expect(await draw("198.51.100.7")).toBe(false);
		}

		clock.advanceBySeconds(rule.capacity / rule.refillPerSecond);

		expect(await draw("198.51.100.7")).toBe(true);
	}, 60_000);

	it("tells a refused caller how long the wait is", async () => {
		for (let attempt = 0; attempt < rule.capacity; attempt += 1) {
			await draw("198.51.100.8");
		}
		const refused = await limiter.consume({
			routeName: "refill",
			rule,
			scope: { kind: "ip_address", ipAddress: "198.51.100.8" },
		});

		expect(refused.allowed).toBe(false);
		expect(refused.retryAfterSeconds).toBeGreaterThan(0);
	});

	/** E-166: the KDF semaphore refuses with the same code and no wait, so absence is a
	 * state a caller meets and not a defect here. */
	it("omits the wait where no refill rate can produce one", async () => {
		const rule = { capacity: 1, refillPerSecond: 0 };
		await limiter.consume({
			routeName: "norefill",
			rule,
			scope: { kind: "ip_address", ipAddress: "198.51.100.9" },
		});
		const refused = await limiter.consume({
			routeName: "norefill",
			rule,
			scope: { kind: "ip_address", ipAddress: "198.51.100.9" },
		});

		expect(refused.allowed).toBe(false);
		expect(refused.retryAfterSeconds).toBeUndefined();
	});
});

describe("the account counter keys by a digest, not by the identifier (S-RATE-7)", () => {
	const rule = { capacity: 3, refillPerSecond: 0.01 };
	const identifier = "owner@example.com";

	it("writes no bucket key from which the identifier can be read", async () => {
		for (let attempt = 0; attempt < rule.capacity + 1; attempt += 1) {
			await limiter.consume({
				routeName: "signIn.password",
				rule,
				scope: { kind: "account", accountIdentifier: identifier },
			});
		}

		const keys = (await readBuckets(connection, schema)).map((row) => row.bucket_key);
		const leaking = keys.filter(
			(key) => key.includes("owner") || key.includes("example.com") || key.includes(identifier),
		);

		expect(leaking).toEqual([]);
		expect(keys.some((key) => key.startsWith("account|signIn.password|"))).toBe(true);
	});

	it("counts an identifier that resolves to nobody on its own bucket", async () => {
		const ghost = "ghost@example.com";
		let allowed = 0;
		for (let attempt = 0; attempt < rule.capacity + 1; attempt += 1) {
			const decision = await limiter.consume({
				routeName: "signIn.password",
				rule,
				scope: { kind: "account", accountIdentifier: ghost },
			});
			allowed += decision.allowed ? 1 : 0;
		}

		expect(allowed).toBe(rule.capacity);
	});
});
