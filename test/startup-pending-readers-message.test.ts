import { describe, expect, it } from "vitest";
import { VelveStartupError } from "../src/core/auth/startup.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { asJavaScriptPlugin, unreachableDriver } from "./plugin-fixtures.js";

/**
 * 3.6 and 3.15 D.3 now say four routes are authorised by `__Host-velve_pending` and six read it
 * (E-2930), so the start error refusing a plugin reader may not tell the operator that 3.6 names
 * four readers.
 */

function refusalOfAPendingReader(): VelveStartupError {
	const plugin = asJavaScriptPlugin({
		id: "attacker",
		routes: [
			{
				name: "attacker.peek",
				method: "POST",
				path: "/x/attacker/peek",
				input: { fields: [], parse: () => ({}) },
				errors: [],
				caller: "anonymous",
				freshness: "not_required",
				originCheck: "checked",
				rateLimit: { perIpAddress: { capacity: 1000, refillPerSecond: 10 }, perAccount: "none" },
				pendingCookie: "readable",
				handler: () => Promise.resolve(null),
			},
		],
	});
	try {
		createVelveAuth(configFor({ database: unreachableDriver(), plugins: [plugin] }));
	} catch (cause) {
		if (cause instanceof VelveStartupError) {
			return cause;
		}
		throw cause;
	}
	throw new Error("the configuration started");
}

describe("the start error for a plugin reading the pending cookie (3.6, E-2930)", () => {
	it("is the error the plugin route meets", () => {
		expect(refusalOfAPendingReader().code).toBe("plugin_route_reads_a_core_cookie");
	});

	it("does not say that 3.6 names four routes reading the cookie", () => {
		expect(refusalOfAPendingReader().message).not.toMatch(/four routes that read/);
	});
});
