import { describe, expect, it } from "vitest";
import type { RateLimitConfig } from "../src/core/auth/config.js";
import { SECURITY_OPTIONS } from "../src/core/auth/security-options.js";
import type { Driver } from "../src/core/db/driver.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, createLogSink } from "./auth-fixtures.js";

/** Starting the instance asks nothing of the driver, so it never needs to answer. */
const refusingDriver: Driver = {
	query: () => Promise.reject(new Error("the start reached the database")),
	transaction: () => Promise.reject(new Error("the start opened a transaction")),
};

const WEAKENED_LINE = "a security option is weaker than its default";

/** The account refill of 2 / 300 is above the default, so every case here writes the line. */
const LOOSER_ACCOUNT = { capacity: 5, refillPerSecond: 2 / 300 };

function chosenFor(perIpAddress: RateLimitConfig["perIpAddress"]): unknown {
	const log = createLogSink();
	createVelveAuth({
		...configFor({
			database: refusingDriver,
			rateLimit: { perIpAddress, perAccount: LOOSER_ACCOUNT },
		}),
		log: log.write,
	});
	return log.lines.find((line) => line.message === WEAKENED_LINE)?.fields.chosen;
}

describe("a refill is written the way an operator reads it (S-DEFAULT-1, E-2675)", () => {
	it("states the default account refill as one per 300 seconds", () => {
		expect(SECURITY_OPTIONS.find((row) => row.option === "rateLimit")?.safeDefault).toBe(
			"per address 30 @ 1 per 2 s, per account 5 @ 1 per 300 s",
		);
	});

	it("writes 2 / 300 as one per 150 seconds", () => {
		expect(chosenFor({ capacity: 30, refillPerSecond: 0.5 })).toBe(
			"per address 30 @ 1 per 2 s, per account 5 @ 1 per 150 s",
		);
	});

	it("writes a refill of one a second as it is", () => {
		expect(chosenFor({ capacity: 30, refillPerSecond: 1 })).toBe(
			"per address 30 @ 1/s, per account 5 @ 1 per 150 s",
		);
	});

	it("writes a refill whose inverse is not whole to four significant figures", () => {
		expect(chosenFor({ capacity: 30, refillPerSecond: 0.012345678 })).toBe(
			"per address 30 @ 0.01235/s, per account 5 @ 1 per 150 s",
		);
		expect(chosenFor({ capacity: 30, refillPerSecond: 0.3 })).toBe(
			"per address 30 @ 0.3/s, per account 5 @ 1 per 150 s",
		);
	});
});
