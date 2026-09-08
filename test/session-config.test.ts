import { describe, expect, it } from "vitest";
import {
	DEFAULT_SESSION_CONFIG,
	InvalidSessionConfigError,
	type SessionConfig,
	type SessionSettings,
	sessionSettingsOf,
} from "../src/core/session/config.js";
import { durationInMilliseconds } from "../src/core/session/duration.js";

const DAY = 86_400_000;

describe("durations", () => {
	it("reads whole seconds, minutes, hours and days", () => {
		expect(durationInMilliseconds("30s")).toBe(30_000);
		expect(durationInMilliseconds("15m")).toBe(900_000);
		expect(durationInMilliseconds("1h")).toBe(3_600_000);
		expect(durationInMilliseconds("7d")).toBe(7 * DAY);
	});

	it("refuses what the template literal type still admits", () => {
		for (const written of ["1.5h", "-7d", "7", "d", "1w", "7 d", "1e3s", ""]) {
			expect({ written, milliseconds: durationInMilliseconds(written) }).toEqual({
				written,
				milliseconds: null,
			});
		}
	});
});

describe("the session defaults (architecture 3.5, 3.15 A.5)", () => {
	it("expires idle after 7 days and absolutely after 30, writes idle hourly, is fresh for 15 minutes", () => {
		const settings: SessionSettings = sessionSettingsOf();

		expect(settings.idleTimeoutMs).toBe(7 * DAY);
		expect(settings.absoluteTimeoutMs).toBe(30 * DAY);
		expect(settings.idleWriteIntervalMs).toBe(3_600_000);
		expect(settings.freshnessWindowMs).toBe(900_000);
	});

	it("names the host-prefixed cookie and sends it lax", () => {
		const settings = sessionSettingsOf();

		expect(settings.cookieName).toBe("__Host-velve_session");
		expect(settings.sameSite).toBe("lax");
		expect(DEFAULT_SESSION_CONFIG.cookieName).toBe(settings.cookieName);
	});

	it("gives the cookie the absolute deadline as its lifetime, never more", () => {
		expect(sessionSettingsOf().cookieMaximumAgeInSeconds).toBe((30 * DAY) / 1000);
		expect(
			sessionSettingsOf({ idleTimeout: "1h", absoluteTimeout: "12h" }).cookieMaximumAgeInSeconds,
		).toBe(43_200);
	});

	it("takes one option without losing the others", () => {
		const settings = sessionSettingsOf({ idleTimeout: "1d" });

		expect(settings.idleTimeoutMs).toBe(DAY);
		expect(settings.absoluteTimeoutMs).toBe(30 * DAY);
	});
});

describe("a configuration that cannot hold", () => {
	function refusedBy(config: Partial<SessionConfig>): string {
		try {
			sessionSettingsOf(config);
		} catch (error) {
			return error instanceof InvalidSessionConfigError ? error.message : "not refused";
		}
		return "not refused";
	}

	it("refuses an idle window that outlives the absolute one", () => {
		expect(refusedBy({ idleTimeout: "31d" })).toContain("idleTimeout");
	});

	it("refuses a write interval no idle window can reach", () => {
		expect(refusedBy({ idleWriteInterval: "8d" })).toContain("idleWriteInterval");
	});

	it("refuses a freshness window longer than the session can live", () => {
		expect(refusedBy({ freshnessWindow: "31d" })).toContain("freshnessWindow");
	});

	it("refuses a deadline of zero", () => {
		expect(refusedBy({ idleTimeout: "0d" })).toContain("above zero");
	});

	it("refuses a cookie name without the __Host- prefix", () => {
		// @ts-expect-error S-COOKIE-1: the prefix is part of the type, so this is caught before it runs.
		expect(refusedBy({ cookieName: "velve_session" })).toContain("__Host-");
		expect(refusedBy({ cookieName: "__Host-velve session" })).toContain("__Host-");
	});

	it("names the option it refused and the value it was given", () => {
		expect(refusedBy({ absoluteTimeout: "1.5h" })).toBe(
			'session.absoluteTimeout must be a whole number of s, m, h or d above zero, not "1.5h"',
		);
	});
});
