import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { VelveAuthConfig } from "../src/core/auth/config.js";
import type { Driver } from "../src/core/db/driver.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, createLogSink } from "./auth-fixtures.js";

/** Starting the instance asks nothing of the driver, so it never needs to answer. */
const refusingDriver: Driver = {
	query: () => Promise.reject(new Error("the start reached the database")),
	transaction: () => Promise.reject(new Error("the start opened a transaction")),
};

const WEAKENED_LINE = "a security option is weaker than its default";

function startWithLog(
	log: VelveAuthConfig<"email">["log"],
	overrides: Partial<VelveAuthConfig<"email">> = {},
) {
	const config = configFor({ database: refusingDriver, ...overrides });
	return createVelveAuth(log === undefined ? config : { ...config, log });
}

let warn: MockInstance<(...data: unknown[]) => void>;

beforeEach(() => {
	warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
	warn.mockRestore();
});

describe("a weakening reaches the operator when no log is configured (S-DEFAULT-1, E-2671)", () => {
	it("warns on the console once per weakened option when no log sink is given", () => {
		startWithLog(undefined, {
			trustedProxies: ["10.0.0.0/8"],
			sessionMetadata: "full",
		});

		expect(warn.mock.calls).toStrictEqual([
			[`[@velve/auth] ${WEAKENED_LINE}`, { option: "sessionMetadata", chosen: "full" }],
			[
				`[@velve/auth] ${WEAKENED_LINE}`,
				{ option: "trustedProxies", chosen: "1 trusted range(s)" },
			],
		]);
	});

	it("leaves the console alone when a log sink is given", () => {
		const log = createLogSink();
		startWithLog(log.write, { trustedProxies: ["10.0.0.0/8"] });

		expect(warn).not.toHaveBeenCalled();
		expect(log.lines.filter((line) => line.message === WEAKENED_LINE)).toHaveLength(1);
	});

	it("says nothing on the console for an instance at its defaults", () => {
		startWithLog(undefined);

		expect(warn).not.toHaveBeenCalled();
	});
});

describe("the instance states the weakenings it reported (S-DEFAULT-1, E-2671)", () => {
	it("holds the same weakenings the start reported, in the same shape", () => {
		const log = createLogSink();
		const auth = startWithLog(log.write, {
			trustedProxies: ["10.0.0.0/8"],
			rateLimit: { perIpAddress: { capacity: 31, refillPerSecond: 0.5 } },
		});

		expect(auth.weakenings).toStrictEqual(
			log.lines.filter((line) => line.message === WEAKENED_LINE).map((line) => line.fields),
		);
		expect(auth.weakenings.map((weakening) => weakening.option)).toStrictEqual([
			"trustedProxies",
			"rateLimit",
		]);
	});

	it("is empty for an instance at its defaults", () => {
		expect(startWithLog(undefined).weakenings).toStrictEqual([]);
	});

	it("cannot be changed from outside", () => {
		const auth = startWithLog(undefined, { trustedProxies: ["10.0.0.0/8"] });

		expect(Object.isFrozen(auth.weakenings)).toBe(true);
		expect(auth.weakenings.every((weakening) => Object.isFrozen(weakening))).toBe(true);
	});
});
