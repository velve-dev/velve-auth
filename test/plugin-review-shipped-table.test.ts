import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PENDING_CALLER_ROUTES } from "../src/core/factor/pending/index.js";
import {
	type AnyRoute,
	type RequestContext,
	readsOAuthStateCookie,
	readsPendingCookie,
} from "../src/core/http/route.js";
import { object } from "../src/core/http/validators.js";
import type { PluginRoute, VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { asJavaScriptPlugin, unreachableDriver } from "./plugin-fixtures.js";

/**
 * S-CACHE-4 counts readers: `PENDING_CALLER_ROUTES` plus the two routes that report and cancel the
 * state. `test/auth-route-table.test.ts` reads the same set over a table mounted **without**
 * plugins, so nothing there sees what a plugin route may declare.
 */
const ROUTES_THAT_MAY_READ_THE_PENDING_COOKIE = new Set<string>([
	...PENDING_CALLER_ROUTES,
	"pending.read",
	"pending.cancel",
]);

/** S-CSRF-5: the pointer belongs to the callback and to nothing else. */
const ROUTES_THAT_MAY_READ_THE_STATE_POINTER = new Set(["signIn.oauth.callback"]);

/**
 * A floor with no meaning of its own, carried because a wave-3 gate found eight of eleven assertions in
 * the core table's own file passing over an empty list.
 */
const CORE_PENDING_READERS = 2;
const PLUGIN_ROUTES = 3;

const reached: string[] = [];

function pluginRoute(
	overrides: Readonly<Record<string, unknown>> & { readonly name: string; readonly path: string },
): PluginRoute<"demo"> {
	return {
		method: "POST",
		input: object({}),
		errors: [] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: { perIpAddress: "none", perAccount: "none" },
		handler: (_input: unknown, _context: RequestContext) => {
			reached.push(overrides.name);
			return Promise.resolve({ seen: true });
		},
		...overrides,
	} as PluginRoute<"demo">;
}

/** Every field of `RouteDeclaration` a plugin may still carry, each at its widest legal value. */
const PLUGIN: VelvePlugin<"demo"> = {
	id: "demo",
	routes: [
		pluginRoute({ name: "demo.read", path: "/x/demo/read", method: "GET" }),
		pluginRoute({
			name: "demo.fresh",
			path: "/x/demo/fresh",
			caller: "session",
			freshness: "required",
		}),
		pluginRoute({ name: "demo.internal", path: "/x/demo/internal", caller: "server_only" }),
	],
};

let mounted: MountedAuth;
let routes: readonly AnyRoute[];

beforeAll(async () => {
	mounted = await mountAuth("pluginshipped", { plugins: [PLUGIN] });
	routes = mounted.auth.routes;
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

function namesOf(subset: readonly AnyRoute[]): readonly string[] {
	return subset.map((route) => route.name);
}

describe("the cookie rules read over a table a plugin contributed to (3.6, S-CACHE-4, S-CSRF-5)", () => {
	it("carries the plugin's routes beside the core's", () => {
		const contributed = namesOf(routes).filter((name) => name.startsWith("demo."));

		expect(contributed).toHaveLength(PLUGIN_ROUTES);
		expect(namesOf(routes)).toContain("signOut");
	});

	it("leaves the pending cookie readable to no route a plugin contributed", () => {
		const readers = namesOf(routes.filter(readsPendingCookie));

		expect(readers.length).toBeGreaterThanOrEqual(CORE_PENDING_READERS);
		expect(readers.filter((name) => !ROUTES_THAT_MAY_READ_THE_PENDING_COOKIE.has(name))).toEqual(
			[],
		);
	});

	it("authorises no route a plugin contributed by the pending state", () => {
		const authorised = namesOf(routes.filter((route) => route.caller === "pending"));

		const permitted = new Set<string>(PENDING_CALLER_ROUTES);

		expect(authorised.filter((name) => !permitted.has(name))).toEqual([]);
	});

	it("leaves the state pointer readable to no route a plugin contributed", () => {
		const readers = namesOf(routes.filter(readsOAuthStateCookie));

		expect(readers.filter((name) => !ROUTES_THAT_MAY_READ_THE_STATE_POINTER.has(name))).toEqual([]);
	});

	it("demands a session of every route that demands freshness", () => {
		const fresh = routes.filter((route) => route.freshness === "required");

		expect(namesOf(fresh)).toContain("demo.fresh");
		expect(namesOf(fresh.filter((route) => route.caller !== "session"))).toEqual([]);
	});

	it("refuses a plugin route that demands freshness without demanding a session", () => {
		expect(() =>
			createVelveAuth(
				configFor({
					database: unreachableDriver(),
					plugins: [
						asJavaScriptPlugin({
							id: "demo",
							routes: [
								pluginRoute({
									name: "demo.loose",
									path: "/x/demo/loose",
									caller: "anonymous",
									freshness: "required",
								}),
							],
						}),
					],
				}),
			),
		).toThrowError(/freshness/);
	});
});

/**
 * S-CSRF-4 bounds the `GET` routes by naming them, and the library cannot tell whether a plugin's
 * `GET` handler changes state — 3.15 G.1's own example plugin declares one. What holds instead is
 * S-CSRF-1, which the origin check applies to a plugin's `GET` like any other route's.
 */
describe("a plugin's GET route is behind the origin check (S-CSRF-1)", () => {
	it("refuses it without an Origin header, before the handler", async () => {
		reached.length = 0;

		const answer = await mounted.handler(
			requestTo("/x/demo/read", { method: "GET", origin: null }),
		);

		expect(answer.status).toBe(403);
		expect(reached).toEqual([]);
	});

	it("refuses it with a foreign Origin, before the handler", async () => {
		reached.length = 0;

		const answer = await mounted.handler(
			requestTo("/x/demo/read", { method: "GET", origin: "https://evil.example.com" }),
		);

		expect(answer.status).toBe(403);
		expect(reached).toEqual([]);
	});

	it("reaches the handler with the configured origin, so the two above refuse something reachable", async () => {
		reached.length = 0;

		const answer = await mounted.handler(requestTo("/x/demo/read", { method: "GET" }));

		expect(answer.status).toBe(200);
		expect(reached).toEqual(["demo.read"]);
	});
});

describe("a plugin route that declares itself server_only", () => {
	it("answers no HTTP request", async () => {
		reached.length = 0;

		const answer = await mounted.handler(requestTo("/x/demo/internal", { body: {} }));

		expect(answer.status).toBe(404);
		expect(reached).toEqual([]);
	});
});
