import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RateLimiter } from "../src/core/http/rate-limit.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { limiterOn } from "./limit-fixtures.js";

/** T-RATE-6 fixes the thresholds: 200 simultaneous requests against a capacity of 20, 50
 * repetitions, tolerance 0. */
const CAPACITY = 20;
const REQUESTS = 200;
const REPETITIONS = 50;

/** One connection per request would ask for 200 of the hundred PostgreSQL grants, and a full
 * run already reaches 89 of them (E-262). Fifty is what a concurrency file has been shown to
 * hold, and it is the width the interleaving is measured at. */
const CONNECTIONS = 50;

/** Low enough that the whole run refills a thousandth of one token, so tolerance 0 is a
 * statement about the statement and not about how long the run took. */
const REFILL_PER_SECOND = 0.001;

const RULE = { capacity: CAPACITY, refillPerSecond: REFILL_PER_SECOND };

let connections: TestConnection[] = [];
let limiters: RateLimiter[] = [];
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("velve_rate_race");
	schema = migrated.schema;
	connections = [migrated.connection];
	for (let index = 1; index < CONNECTIONS; index += 1) {
		connections.push(await openTestConnection());
	}
	limiters = connections.map((connection) =>
		limiterOn(connection, schema, { now: () => new Date() }),
	);
}, 120_000);

afterAll(async () => {
	const [first] = connections;
	if (first !== undefined) {
		await dropSchema(first, schema);
	}
	await Promise.all(connections.map((connection) => connection.close()));
});

async function raceOneBucket(routeName: string): Promise<{ allowed: number; refused: number }> {
	const decisions = await Promise.all(
		Array.from({ length: REQUESTS }, (_, request) => {
			const limiter = limiters[request % limiters.length];
			if (limiter === undefined) {
				throw new Error("the limiter pool is empty");
			}
			return limiter.consume({
				routeName,
				rule: RULE,
				scope: { kind: "ip_address", ipAddress: "203.0.113.5" },
			});
		}),
	);

	const allowed = decisions.filter((decision) => decision.allowed).length;
	return { allowed, refused: decisions.length - allowed };
}

describe("T-RATE-6 — one statement per check bounds the winners (S-RATE-6)", () => {
	it.skipIf(process.env.VELVE_NIGHTLY !== "1")(
		"admits exactly the capacity in every one of fifty runs of two hundred",
		async () => {
			const runs: { allowed: number; refused: number }[] = [];
			for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
				runs.push(await raceOneBucket(`race-${repetition}`));
			}

			const exact = runs.filter(
				(run) => run.allowed === CAPACITY && run.refused === REQUESTS - CAPACITY,
			);

			expect(runs).toHaveLength(REPETITIONS);
			expect(exact).toHaveLength(REPETITIONS);
		},
		600_000,
	);
});
