import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { RateLimitConfig } from "../src/core/auth/config.js";
import { SECURITY_OPTIONS } from "../src/core/auth/security-options.js";
import type { Driver } from "../src/core/db/driver.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, createLogSink, requestTo } from "./auth-fixtures.js";

/** Starting the instance asks nothing of the driver, and a request that reaches it fails. */
const refusingDriver: Driver = {
	query: () => Promise.reject(new Error("the request reached the database")),
	transaction: () => Promise.reject(new Error("the request opened a transaction")),
};

const WEAKENED_LINE = "a security option is weaker than its default";

function weakenedOptionsFor(rateLimit: Partial<RateLimitConfig>): readonly string[] {
	const log = createLogSink();
	createVelveAuth({ ...configFor({ database: refusingDriver, rateLimit }), log: log.write });
	return log.lines
		.filter((line) => line.message === WEAKENED_LINE)
		.map((line) => String(line.fields?.option));
}

let warn: MockInstance<(...data: unknown[]) => void>;

beforeEach(() => {
	warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
	warn.mockRestore();
});

describe("a weakening is measured against the new defaults, not the old ones (S-DEFAULT-1, E-2670)", () => {
	it("reports nothing for the old address default, which is now stricter", () => {
		expect(
			weakenedOptionsFor({ perIpAddress: { capacity: 10, refillPerSecond: 0.1 } }),
		).toStrictEqual([]);
	});

	it("reports the old account default, which is now looser", () => {
		expect(
			weakenedOptionsFor({ perAccount: { capacity: 5, refillPerSecond: 0.01 } }),
		).toStrictEqual(["rateLimit"]);
	});

	it("reports the old defaults written out together once, for the account bucket", () => {
		expect(
			weakenedOptionsFor({
				perIpAddress: { capacity: 10, refillPerSecond: 0.1 },
				perAccount: { capacity: 5, refillPerSecond: 0.01 },
			}),
		).toStrictEqual(["rateLimit"]);
	});

	it("reports nothing for the new defaults written out", () => {
		expect(
			weakenedOptionsFor({
				perIpAddress: { capacity: 30, refillPerSecond: 0.5 },
				perAccount: { capacity: 5, refillPerSecond: 1 / 300 },
			}),
		).toStrictEqual([]);
	});

	it("reports an account capacity one above the default", () => {
		expect(
			weakenedOptionsFor({ perAccount: { capacity: 6, refillPerSecond: 1 / 300 } }),
		).toStrictEqual(["rateLimit"]);
	});

	it("states the new defaults in SECURITY_OPTIONS", () => {
		const rateLimit = SECURITY_OPTIONS.find((option) => option.option === "rateLimit");
		expect(rateLimit?.safeDefault).toMatch(/^per address 30 @ 0\.5\/s, per account 5 @ /);
	});
});

describe("the console fallback is a start-time line and never a request-time one (S-DEFAULT-1, E-2671)", () => {
	it("writes nothing more to the console while requests fail after the start", async () => {
		const auth = createVelveAuth(
			configFor({ database: refusingDriver, trustedProxies: ["10.0.0.0/8"] }),
		);
		const handler = toWebHandler(auth);
		const atStart = warn.mock.calls.length;

		for (let attempt = 0; attempt < 5; attempt += 1) {
			await handler(requestTo("/sign-out"));
			await handler(
				requestTo("/sign-in/password", { body: { email: "a@example.com", password: "x" } }),
			);
		}
		auth.http.log("warn", "a request-time line", { route: "probe" });

		expect(atStart).toBe(1);
		expect(warn.mock.calls.length).toBe(atStart);
	});
});

describe("auth.weakenings cannot be changed to hide a weakening (S-DEFAULT-1, E-2671)", () => {
	it("refuses a push, a removal and a rewritten entry", () => {
		const auth = createVelveAuth(
			configFor({ database: refusingDriver, trustedProxies: ["10.0.0.0/8"] }),
		);
		const weakenings = auth.weakenings as unknown as { option: string; chosen: string }[];

		expect(() => weakenings.pop()).toThrow(TypeError);
		expect(() => weakenings.push({ option: "x", chosen: "y" })).toThrow(TypeError);
		expect(() => {
			(weakenings[0] as { option: string }).option = "schema";
		}).toThrow(TypeError);
		expect(auth.weakenings).toStrictEqual([
			{ option: "trustedProxies", chosen: "1 trusted range(s)" },
		]);
	});
});
