import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { RateAlert, VelveAuthConfig } from "../src/core/auth/config.js";
import { rateLimitConfigOf } from "../src/core/auth/rate-limiting.js";
import type { Driver } from "../src/core/db/driver.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, createLogSink } from "./auth-fixtures.js";

/** The flood counter observes before the bucket is drawn, so the driver never needs to answer. */
const refusingDriver: Driver = {
	query: () => Promise.reject(new Error("the bucket draw reached the database")),
	transaction: () => Promise.reject(new Error("the bucket draw opened a transaction")),
};

const ALARM_LINE = "a route is taking more requests than its alert threshold";
const ROUTE = "signIn.password";
const THRESHOLD = rateLimitConfigOf().globalPerRoute.alertThresholdPerMinute;

function settableClock(start: Date) {
	let now = start.getTime();
	return {
		now: () => new Date(now),
		advanceSeconds(seconds: number) {
			now += seconds * 1000;
		},
	};
}

function startWithLog(
	log: VelveAuthConfig<"email">["log"],
	overrides: Partial<VelveAuthConfig<"email">> = {},
) {
	const clock = settableClock(new Date("2026-10-04T12:00:00.000Z"));
	const config = configFor({ database: refusingDriver, clock, ...overrides });
	const auth = createVelveAuth(log === undefined ? config : { ...config, log });
	return { auth, clock };
}

/** One request past the threshold from a full allowance, which is one transition into exhaustion. */
async function floodPastTheThreshold(
	auth: ReturnType<typeof startWithLog>["auth"],
	routeName = ROUTE,
): Promise<void> {
	const rule = { capacity: 30, refillPerSecond: 0.5 };
	const draws = Array.from({ length: THRESHOLD + 1 }, () =>
		auth.http.rateLimiter
			.consume({ routeName, rule, scope: { kind: "ip_address", ipAddress: "203.0.113.5" } })
			.catch(() => undefined),
	);
	await Promise.all(draws);
}

let warn: MockInstance<(...data: unknown[]) => void>;

beforeEach(() => {
	warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
	warn.mockRestore();
});

describe("the default route alarm is heard (S-RATE-8, E-2672)", () => {
	it("writes the alarm to the log sink when one is configured", async () => {
		const log = createLogSink();
		const { auth } = startWithLog(log.write);

		await floodPastTheThreshold(auth);

		const alarms = log.lines.filter((line) => line.message === ALARM_LINE);
		expect(alarms).toHaveLength(1);
		expect(alarms[0]?.level).toBe("warn");
		expect(alarms[0]?.fields).toMatchObject({ routeName: ROUTE });
		expect(warn).not.toHaveBeenCalled();
	});

	/** The settable clock is itself a weakening, so the console also carries that line. */
	it("warns on the console when no log sink is configured", async () => {
		const { auth } = startWithLog(undefined);

		await floodPastTheThreshold(auth);

		const alarms = warn.mock.calls.filter(([message]) => message === `[@velve/auth] ${ALARM_LINE}`);
		expect(alarms).toHaveLength(1);
		expect(alarms[0]?.[1]).toMatchObject({ routeName: ROUTE });
	});

	it("reports one route at most once a minute however often it floods", async () => {
		const log = createLogSink();
		const { auth, clock } = startWithLog(log.write);
		const alarmsSoFar = () => log.lines.filter((line) => line.message === ALARM_LINE).length;

		await floodPastTheThreshold(auth);
		clock.advanceSeconds(59);
		await floodPastTheThreshold(auth);
		expect(alarmsSoFar()).toBe(1);

		clock.advanceSeconds(1);
		await floodPastTheThreshold(auth);
		expect(alarmsSoFar()).toBe(2);
	});

	it("reports a second route in the same minute as the first", async () => {
		const log = createLogSink();
		const { auth } = startWithLog(log.write);

		await floodPastTheThreshold(auth, ROUTE);
		await floodPastTheThreshold(auth, "password.reset.request");

		expect(
			log.lines.filter((line) => line.message === ALARM_LINE).map((line) => line.fields.routeName),
		).toStrictEqual([ROUTE, "password.reset.request"]);
	});

	it("leaves the alarm to the application's own onAlert when it gives one", async () => {
		const log = createLogSink();
		const heard: RateAlert[] = [];
		const { auth } = startWithLog(log.write, {
			rateLimit: {
				globalPerRoute: {
					alertThresholdPerMinute: THRESHOLD,
					onAlert: (alert) => heard.push(alert),
				},
			},
		});

		await floodPastTheThreshold(auth);

		expect(heard).toHaveLength(1);
		expect(log.lines.filter((line) => line.message === ALARM_LINE)).toStrictEqual([]);
		expect(warn).not.toHaveBeenCalled();
	});
});
