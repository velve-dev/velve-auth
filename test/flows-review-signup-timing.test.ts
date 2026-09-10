import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VelveAuthConfig } from "../src/core/auth/config.js";
import type { Driver } from "../src/core/db/driver.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createVelveAuth } from "../src/index.js";
import { TEST_ORIGIN, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import {
	CONTROL_RECOVERY_TOLERANCE,
	cliffsDelta,
	DISCARDED_WARMUP,
	describeResolution,
	MEASUREMENTS_PER_GROUP,
	mean,
	median,
	overlapResolutionNs,
	PLANTED_CONTROL_LEAK_NS,
	resolutionOf,
	sampleUntilResolved,
	type TimingArm,
	TRIM_FRACTION,
	trimmed,
	WELCH_T_LIMIT,
	welchT,
} from "./timing-fixtures.js";

// Architecture 6.1 and 6.20 decide T-TIM-1 on |t| < 4.5 and Cliff's delta < 0.147. Neither is
// asserted below and the comment there says why; the sample floor is T-TIM-1's.

const TAKEN = "occupied.address@example.com";

let migrated: MigratedSchema;
let handler: (request: Request) => Promise<Response>;
let statements: string[] = [];

function recording(driver: Driver): Driver {
	const wrap = (inner: Driver): Driver => ({
		query: (sql, params) => {
			statements.push(sql.replace(/\s+/g, " ").trim().slice(0, 60));
			return inner.query(sql, params);
		},
		transaction: (run) => {
			statements.push("BEGIN");
			return inner.transaction((tx) => run(wrap(tx)));
		},
	});
	return wrap(driver);
}

function post(path: string, body: unknown): Promise<Response> {
	return handler(
		new Request(`https://api.example.com${path}`, {
			method: "POST",
			headers: { Origin: TEST_ORIGIN, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

/** An address of the length `TAKEN` has, so nothing but occupancy separates the two groups. */
function freeAddressNumbered(index: number): string {
	const digits = String(index).padStart(6, "0");
	return `vacant.a${digits}@example.com`.padEnd(TAKEN.length, "x");
}

beforeEach(async () => {
	migrated = await openMigratedSchema("signuptiming");
	statements = [];
	const auth = createVelveAuth({
		identity: { mode: "email" },
		database: recording(migrated.connection),
		schema: migrated.schema,
		keys: testKeyProvider(),
		origins: [TEST_ORIGIN],
		rateLimit: {
			perIpAddress: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
			perAccount: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
		},
		email: { send: () => Promise.resolve() },
	} as VelveAuthConfig<"email">);
	handler = toWebHandler(auth);
	await post("/sign-up/passwordless", { email: TAKEN });
});

afterEach(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

/**
 * T-TIM-1b's method rather than T-TIM-1's: the call sequence is deterministic and names the cause,
 * where the wall clock only reports the symptom. `/sign-up/passwordless` has no KDF, so the
 * difference between its two branches is the whole of what a caller can measure.
 */
describe("S-TIM-6, T-TIM-1b: the two branches of a sign-up issue the same calls", () => {
	it("runs the same statements for a taken and for a free address, without a password", async () => {
		statements = [];
		await post("/sign-up/passwordless", { email: TAKEN });
		const onTaken = [...statements];
		statements = [];
		await post("/sign-up/passwordless", { email: freeAddressNumbered(1) });
		const onFree = [...statements];

		expect(onTaken.length).toBeGreaterThan(1);
		expect(onTaken).toStrictEqual(onFree);
	});
});

/**
 * One run of this on 2026-09-09, in process against a local PostgreSQL 18.3, 1000 measurements per
 * group interleaved and the first 100 of each discarded: Welch t on 10 per cent trimmed means
 * -128.87 against a limit of 4.5, Cliff's delta -0.947 against a limit of 0.147, median 402666 ns
 * on a taken address against 752125 ns on a free one. The measurement is in process rather than
 * TTFB over a socket, so the absolute numbers are a floor on the gap and not the gap a caller sees.
 *
 * After E-627 the branches run the same statements and the separation collapses, but **T-TIM-1's own
 * two thresholds are still not met**. Six runs on the same machine, cover rolled back: |t| 4.6, 5.7,
 * 8.2, 9.8, 10.6, 19.6, Cliff's delta 0.12 to 0.38, medians within 4 to 10 per cent of each other. A
 * control of free against free on the same harness gives |t| 0.74 and 2.42, so the harness is sound
 * and what is left is real: the free branch commits a transaction and the cover branch rolls one
 * back, and a commit costs a WAL flush the rollback does not. Closing it needs a cover account that
 * persists, which E-629 refuses.
 *
 * What is asserted is the specification's own number where there is one, and the measured residual
 * where there is not (E-933). Those six |t| values were taken at whatever standard error the runner
 * happened to hand out, and |t| is a difference divided by that standard error, so they are six
 * measurements of six different things; the sampler below fixes the divisor instead (E-1535).
 */
describe("T-TIM-1's method on the row that has no KDF to hide behind", () => {
	/**
	 * T-TIM-6's threshold — "Differenz der Mediane des ersten Antwortbytes < 5 ms" — rather than a
	 * fraction invented here. It is the only number the specification fixes for two branches that
	 * must not be tellable apart by time on an endpoint with no KDF; T-TIM-6 names the two request
	 * rows and not this one, and 3.13 puts all three under the same rule (E-933).
	 */
	const MEDIAN_DIFFERENCE_LIMIT_MS = 5;

	/**
	 * T-TIM-1's own two thresholds are 4.5 and 0.147 and are not met; E-629 says why. These bound
	 * what was measured instead, so a separation that grows back towards the 128.87 and 0.947 the
	 * first paragraph records fails here rather than being reported to nobody (E-933). Neither is
	 * moved here: what the sampler changes is that they are now read at a standard error the run had
	 * to reach, so the same number means the same thing twice (E-1535).
	 */
	const WELCH_T_CEILING = 25;
	const CLIFFS_DELTA_CEILING = 0.5;

	const BLOCK_PER_GROUP = 250;
	const MAXIMUM_PER_GROUP = 6_000;
	const RESOLUTION_BUDGET_MS = 300_000;
	const CASE_TIMEOUT_MS = 900_000;

	it.skipIf(process.env.VELVE_NIGHTLY !== "1")(
		"holds T-TIM-6's five milliseconds, and pins the two thresholds it does not meet",
		async () => {
			let freeAddresses = 0;
			const samples = await sampleUntilResolved(
				async (arm: TimingArm) => {
					if (arm === "absent") {
						freeAddresses += 1;
						await post("/sign-up/passwordless", { email: freeAddressNumbered(freeAddresses) });
						return;
					}
					await post("/sign-up/passwordless", { email: TAKEN });
				},
				{
					minimumPerGroup: MEASUREMENTS_PER_GROUP,
					maximumPerGroup: MAXIMUM_PER_GROUP,
					discardedWarmup: DISCARDED_WARMUP,
					blockPerGroup: BLOCK_PER_GROUP,
					budgetMs: RESOLUTION_BUDGET_MS,
				},
			);

			const taken = trimmed(samples.present, TRIM_FRACTION);
			const free = trimmed(samples.absent, TRIM_FRACTION);
			const resolution = resolutionOf(taken, free);
			const reached = describeResolution(taken, free);
			const planted = trimmed(samples.controlPlanted, TRIM_FRACTION);
			const quiet = trimmed(samples.controlQuiet, TRIM_FRACTION);
			const recovered = mean(planted) - mean(quiet);

			const NANOSECONDS_PER_MILLISECOND = 1_000_000;
			const medianDifference =
				Math.abs(median(samples.present) - median(samples.absent)) / NANOSECONDS_PER_MILLISECOND;
			const welch = Math.abs(welchT(taken, free));
			const delta = Math.abs(cliffsDelta(samples.present, samples.absent));
			const measured = `median difference ${medianDifference.toFixed(3)} ms, |t| ${welch.toFixed(1)}, Cliff's delta ${delta.toFixed(3)} separating about ${Math.round(overlapResolutionNs(samples.present, samples.absent))} ns, ${reached}`;

			expect(samples.roundsPerGroup).toBeGreaterThanOrEqual(MEASUREMENTS_PER_GROUP);
			expect(
				resolution.resolvesTheLeakThatMatters,
				`the run could not resolve the smallest leak 5.1 (a) names, so the three numbers below bound nothing: ${measured}`,
			).toBe(true);
			expect(
				Math.abs(welchT(planted, quiet)),
				`the run did not see a planted ${PLANTED_CONTROL_LEAK_NS} ns leak: ${reached}`,
			).toBeGreaterThan(WELCH_T_LIMIT);
			expect(
				Math.abs(recovered - PLANTED_CONTROL_LEAK_NS) / PLANTED_CONTROL_LEAK_NS,
				`the planted leak was measured as ${Math.round(recovered)} ns`,
			).toBeLessThan(CONTROL_RECOVERY_TOLERANCE);

			expect(medianDifference, `T-TIM-6: ${measured}`).toBeLessThan(MEDIAN_DIFFERENCE_LIMIT_MS);
			expect(welch, `pinned above T-TIM-1, not meeting it: ${measured}`).toBeLessThan(
				WELCH_T_CEILING,
			);
			expect(delta, `pinned above T-TIM-1, not meeting it: ${measured}`).toBeLessThan(
				CLIFFS_DELTA_CEILING,
			);
		},
		CASE_TIMEOUT_MS,
	);
});
