import { describe, expect, it } from "vitest";
import { object } from "../src/core/http/validators.js";
import type { PluginRoute, VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { unreachableDriver } from "./plugin-fixtures.js";

/**
 * 3.15 G: a plugin route's `name` begins with `${Id}.` and its path with `/x/${Id}/`. The type
 * says so; at run time a plugin written in JavaScript is held only to the core's reserved first
 * segments, so a route can be mounted under another plugin's prefix, outside `/x/` altogether, or
 * at the root of the instance under a name no core namespace lists.
 */

function routeOf(name: string, path: string): PluginRoute<"probe"> {
	return {
		name,
		method: "POST",
		path,
		input: object({}),
		errors: [] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: { perIpAddress: { capacity: 10, refillPerSecond: 1 }, perAccount: "none" },
		handler: () => Promise.resolve({ ok: true }),
	} as PluginRoute<"probe">;
}

function startsWith(route: PluginRoute<"probe">): { started: boolean; thenMember: unknown } {
	try {
		const auth = createVelveAuth(
			configFor({
				database: unreachableDriver(),
				plugins: [{ id: "probe", routes: [route] } as VelvePlugin<"probe">],
			}),
		);
		return { started: true, thenMember: Reflect.get(auth, "then") };
	} catch {
		return { started: false, thenMember: undefined };
	}
}

describe("a plugin route stays inside its own namespace at run time (3.11, 3.15 G)", () => {
	it("refuses a route whose path lies outside /x/<id>/", () => {
		expect(startsWith(routeOf("probe.reset", "/password/reset-now")).started).toBe(false);
	});

	it("refuses a route whose name does not begin with the plugin id", () => {
		expect(startsWith(routeOf("other.thing", "/x/probe/thing")).started).toBe(false);
	});

	it("refuses a segment a promise or every object reads inside the plugin's own namespace", () => {
		for (const segment of ["then", "catch", "finally", "toString", "valueOf", "constructor"]) {
			expect(startsWith(routeOf(`probe.${segment}`, `/x/probe/${segment}`)).started, segment).toBe(
				false,
			);
		}
	});

	it("starts a route inside its own namespace", () => {
		expect(startsWith(routeOf("probe.ping", "/x/probe/ping")).started).toBe(true);
	});

	it("does not make the instance a thenable through a route named then", () => {
		const outcome = startsWith(routeOf("then", "/x/probe/then"));

		expect(typeof outcome.thenMember, "auth.then is the plugin's server method").not.toBe(
			"function",
		);
	});
});
