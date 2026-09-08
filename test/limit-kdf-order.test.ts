import { afterEach, describe, expect, it } from "vitest";
import { createKdfSemaphore } from "../src/core/password/semaphore.js";
import { type Harness, NO_LIMIT, openLimitHarness, signInRequest } from "./limit-fixtures.js";

const LIMIT = 5;
const REQUESTS = 100;

let harness: Harness | null = null;

afterEach(async () => {
	await harness?.close();
	harness = null;
});

describe("T-DOS-5 — the limiter runs before the semaphore is asked for a place (S-DOS-5)", () => {
	it("lets at most the limit reach a key derivation out of a hundred requests", async () => {
		const semaphore = createKdfSemaphore({ limit: 1 });
		let acquisitions = 0;
		let derivations = 0;

		harness = await openLimitHarness({
			signIn: { perIpAddress: { capacity: LIMIT, refillPerSecond: 0.001 }, perAccount: "none" },
			probe: NO_LIMIT,
			connectionAddress: () => "203.0.113.5",
			onCredentialCheck: async () => {
				acquisitions += 1;
				await semaphore.run(async () => {
					derivations += 1;
				});
			},
		});

		const statuses: number[] = [];
		for (let attempt = 0; attempt < REQUESTS; attempt += 1) {
			const response = await harness.handle(
				signInRequest("/sign-in/password", { identifier: "owner@example.com", password: "x" }),
			);
			statuses.push(response.status);
		}

		expect(harness.limiter.requests).toHaveLength(REQUESTS);
		expect(statuses.filter((status) => status === 429)).toHaveLength(REQUESTS - LIMIT);
		expect(acquisitions).toBeLessThanOrEqual(LIMIT);
		expect(derivations).toBeLessThanOrEqual(LIMIT);
		expect(semaphore.peakInFlight).toBeLessThanOrEqual(LIMIT);
	}, 60_000);
});
