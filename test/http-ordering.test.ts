import { describe, expect, it } from "vitest";
import { VelveError } from "../src/core/http/error-map.js";
import { defineRoute } from "../src/core/http/route.js";
import { matchRoute } from "../src/core/http/router.js";
import { createServerMethod } from "../src/core/http/server-method.js";
import { object, string } from "../src/core/http/validators.js";
import { toWebHandler } from "../src/http/index.js";
import {
	ALLOWED_ORIGIN,
	callbackRoute,
	createHarness,
	requestTo,
	signInRoute,
} from "./http-fixtures.js";

const FOREIGN_ORIGIN = "https://app.example.com.evil.com";

const observedRoute = defineRoute({
	name: "test.observed",
	method: "POST",
	path: "/test/observed",
	input: object({ value: string() }),
	errors: ["invalid_input"] as const,
	caller: "session",
	freshness: "not_required",
	originCheck: "checked",
	rateLimit: {
		perIpAddress: { capacity: 10, refillPerSecond: 1 },
		perAccount: { capacity: 5, refillPerSecond: 0.01 },
	},
	handler: async (input) => ({ echoed: input.value }),
});

const declaredButUncountedRoute = defineRoute({
	name: "test.declaredButUncounted",
	method: "POST",
	path: "/test/declared-but-uncounted",
	input: object({ identifier: string() }),
	errors: ["rate_limited"] as const,
	caller: "anonymous",
	freshness: "not_required",
	originCheck: "checked",
	rateLimit: {
		perIpAddress: "none",
		perAccount: { capacity: 5, refillPerSecond: 0.01 },
	},
	handler: async () => ({ done: true }),
});

describe("ordering — S-CSRF-1, 3.11 last bullet", () => {
	it("rejects a foreign origin on the web handler before anything else happens", async () => {
		const { environment, rateLimitRequests, logs } = createHarness({ routes: [observedRoute] });
		const response = await toWebHandler({ http: environment })(
			requestTo("/test/observed", {
				origin: FOREIGN_ORIGIN,
				cookie: "__Host-velve_session=abc",
				body: { value: 7 },
			}),
		);

		expect(response.status).toBe(403);
		expect(rateLimitRequests).toEqual([]);
		expect(logs.map((entry) => entry.fields)).toEqual([
			{ route: "test.observed", reason: "origin_not_allowed" },
		]);
	});

	it("rejects a foreign origin on the direct server method too", async () => {
		const { environment, rateLimitRequests } = createHarness();
		const signIn = createServerMethod(signInRoute, environment);

		for (const origin of [FOREIGN_ORIGIN, null, "https://evil.com", "app.example.com"]) {
			await expect(signIn({ identifier: "someone@example.com", origin })).rejects.toThrow(
				new VelveError("origin_not_allowed"),
			);
		}
		expect(rateLimitRequests).toEqual([]);
	});

	it("counts the address bucket before the input is parsed and before the caller is resolved", async () => {
		const { environment, rateLimitRequests } = createHarness({ routes: [observedRoute] });
		const response = await toWebHandler({ http: environment })(
			requestTo("/test/observed", { body: { value: 7 } }),
		);

		expect(response.status).toBe(400);
		expect(rateLimitRequests.map((request) => request.scope.kind)).toEqual(["ip_address"]);
	});

	it("counts the address bucket even when no client address is known (S-RATE-4)", async () => {
		const { environment, rateLimitRequests } = createHarness({ routes: [observedRoute] });
		await toWebHandler({ http: environment })(
			requestTo("/test/observed", { body: { value: "x" } }),
		);

		expect(rateLimitRequests).toEqual([
			{
				routeName: "test.observed",
				rule: { capacity: 10, refillPerSecond: 1 },
				scope: { kind: "ip_address", ipAddress: null },
			},
		]);
	});

	it("has exactly one route that skips the origin check, and it is the OAuth callback", () => {
		const { environment } = createHarness();
		const exempt = environment.routes.filter((route) => route.originCheck === "exempt");

		expect(exempt.map((route) => route.name)).toEqual([callbackRoute.name]);
	});

	it("rejects every checked route with the same bytes on both call paths", async () => {
		const { environment } = createHarness();
		const handler = toWebHandler({ http: environment });
		const answers = new Set<string>();

		for (const route of environment.routes) {
			if (route.originCheck !== "checked" || route.caller === "server_only") {
				continue;
			}
			const response = await handler(
				requestTo(route.path, { method: route.method, origin: FOREIGN_ORIGIN }),
			);
			answers.add(`${response.status}|${await response.text()}`);
		}

		expect([...answers]).toEqual([
			'403|{"error":{"code":"origin_not_allowed","message":"The request origin is not allowed."}}',
		]);
	});

	it("never consumes the declared account bucket unless the route asks for it", async () => {
		const { environment, rateLimitRequests } = createHarness({
			routes: [declaredButUncountedRoute],
		});
		const response = await toWebHandler({ http: environment })(
			requestTo("/test/declared-but-uncounted", { body: { identifier: "someone@example.com" } }),
		);

		expect(response.status).toBe(200);
		expect(rateLimitRequests).toEqual([]);
	});

	it("offers no way to run a handler from the route object alone", async () => {
		const { environment, rateLimitRequests } = createHarness();
		const [route] = environment.routes.filter((candidate) => candidate.name === "test.signIn");
		const reachable = Object.entries(route ?? {}).filter(
			([, member]) => typeof member === "function",
		);

		expect(reachable.map(([member]) => member)).toEqual([]);
		expect(Object.keys(route ?? {})).not.toContain("invoke");
		expect(rateLimitRequests).toEqual([]);
	});
});

describe("rate limit key — S-RATE-5", () => {
	const VARIANTS = [
		"/test/echo",
		"//test/echo",
		"/test/echo/",
		"/./test/echo",
		"/test//echo",
		"/test/ech%6F",
		"/TEST/ECHO",
	];

	it("resolves every written form of one path to the same declared route", () => {
		const { environment } = createHarness();
		const pathnames = VARIANTS.map((path) => new URL(`https://api.example.com${path}`).pathname);

		expect(
			pathnames.map((path) => [path, matchRoute(environment.routes, "POST", path, "")?.route.name]),
		).toEqual(pathnames.map((path) => [path, "test.echo"]));
	});

	it("counts every written form of one path on the same bucket", async () => {
		const { environment, rateLimitRequests } = createHarness();
		const handler = toWebHandler({ http: environment });

		for (const path of VARIANTS) {
			await handler(requestTo(path, { body: { value: "x" } }));
		}

		expect(rateLimitRequests.map((request) => request.routeName)).toEqual(
			VARIANTS.map(() => "test.echo"),
		);
	});

	it("keys the bucket on the declared name and never on the request path", async () => {
		const { environment, rateLimitRequests } = createHarness();
		await toWebHandler({ http: environment })(requestTo("//test/echo/", { body: { value: "x" } }));

		for (const request of rateLimitRequests) {
			expect(request.routeName).toBe("test.echo");
			expect(JSON.stringify(request)).not.toContain("/test/echo");
		}
	});
});

describe("server method surface", () => {
	it("passes the caller tokens as named fields and never from the input body", async () => {
		const { environment } = createHarness();
		const method = createServerMethod(observedRoute, environment);

		await expect(
			method({ value: "x", origin: ALLOWED_ORIGIN, sessionToken: "abc" }),
		).resolves.toEqual({ echoed: "x" });
		await expect(method({ value: "x", origin: ALLOWED_ORIGIN })).rejects.toThrow();
	});

	it("gives the caller a mapped VelveError and never a raw internal reason", async () => {
		const { environment } = createHarness();
		const method = createServerMethod(observedRoute, environment);

		const cause = await method({ value: "x", origin: ALLOWED_ORIGIN }).catch(
			(failure: unknown) => failure,
		);

		expect(cause).toBeInstanceOf(VelveError);
		expect((cause as VelveError).code).toBe("session_required");
		expect(String((cause as Error).message)).not.toContain("cookie_absent");
	});

	it("logs the true reason of a rejected direct call (S-ENUM-6)", async () => {
		const { environment, logs } = createHarness();
		const method = createServerMethod(observedRoute, environment);

		await method({ value: "x", origin: ALLOWED_ORIGIN }).catch(() => undefined);

		expect(logs.map((entry) => entry.fields)).toEqual([
			{ route: "test.observed", reason: "cookie_absent" },
		]);
	});
});
