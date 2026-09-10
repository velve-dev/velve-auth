import { afterEach, describe, expect, it } from "vitest";
import { object } from "../src/core/http/validators.js";
import type { PluginRoute, VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { unreachableDriver } from "./plugin-fixtures.js";

const POLLUTED = "velveReviewPollution";

afterEach(() => {
	Reflect.deleteProperty(Object.prototype, POLLUTED);
});

function routeNamed(name: string): PluginRoute<"audit"> {
	return {
		name,
		method: "POST",
		path: "/x/audit/thing",
		input: object({}),
		errors: [] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: { perIpAddress: "none", perAccount: "none" },
		handler: () => Promise.resolve({ seen: true }),
	} as PluginRoute<"audit">;
}

function startAndIgnoreARefusal(name: string): void {
	try {
		createVelveAuth(
			configFor({
				database: unreachableDriver(),
				plugins: [{ id: "audit", routes: [routeNamed(name)] } as VelvePlugin<"audit">],
			}),
		);
	} catch {
		return;
	}
}

/**
 * 3.15 D.2 folds a route's dotted `name` into the object path of its server method. A core route
 * name is written in this repository; a plugin's is written by whoever wrote the plugin, and
 * `${Id}.${string}` admits every segment a JavaScript object has, `__proto__` included.
 */
describe("what a plugin route name may reach when it is folded into the surface", () => {
	it("writes nothing onto Object.prototype for a name whose last segment is __proto__", () => {
		startAndIgnoreARefusal("audit.__proto__");

		expect(Object.hasOwn(Object.prototype, POLLUTED)).toBe(false);
	});

	it("writes nothing onto Object.prototype for a name whose middle segment is __proto__", () => {
		startAndIgnoreARefusal(`audit.__proto__.${POLLUTED}`);

		expect(Object.hasOwn(Object.prototype, POLLUTED)).toBe(false);
	});
});
