import { describe, expect, it } from "vitest";
import { ConcealedError } from "../src/core/http/error-map.js";
import { defineRoute, type RouteDeclaration } from "../src/core/http/route.js";
import { object } from "../src/core/http/validators.js";
import { toWebHandler } from "../src/http/index.js";
import { ALLOWED_ORIGIN, createHarness, failingRoute, requestTo } from "./http-fixtures.js";

const COLLIDING_DECLARATION = {
	name: "test.collision",
	method: "POST",
	path: "/test/collision",
	input: object({}),
	errors: [],
	caller: "anonymous",
	freshness: "not_required",
	originCheck: "checked",
	rateLimit: { perIpAddress: "none", perAccount: "none" },
	handler: async () => ({ done: true }),
} satisfies RouteDeclaration<string, string, Record<string, never>, { done: boolean }, never>;

describe("web handler", () => {
	it("answers a declared route from its declaration", async () => {
		const { environment } = createHarness();
		const response = await toWebHandler({ http: environment })(
			requestTo("/test/echo", { body: { value: "hello" } }),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ echoed: "hello" });
	});

	it("puts no-store and Vary: Cookie on every response", async () => {
		const { environment } = createHarness();
		const handler = toWebHandler({ http: environment });
		const responses = [
			await handler(requestTo("/test/echo", { body: { value: "hello" } })),
			await handler(requestTo("/test/echo", { origin: "https://evil.com" })),
			await handler(requestTo("/test/unknown")),
			await handler(requestTo("/test/sign-out")),
		];

		for (const response of responses) {
			expect(response.headers.get("Cache-Control")).toBe("no-store");
			expect(response.headers.get("Vary")).toBe("Cookie");
		}
	});

	it("rejects a foreign origin before the handler runs", async () => {
		const { environment, rateLimitRequests } = createHarness();
		const response = await toWebHandler({ http: environment })(
			requestTo("/test/echo", { origin: "https://app.example.com.evil.com", body: { value: "x" } }),
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: { code: "origin_not_allowed", message: "The request origin is not allowed." },
		});
		expect(rateLimitRequests).toHaveLength(0);
	});

	it("answers every rejected origin variant with the same bytes", async () => {
		const { environment } = createHarness();
		const handler = toWebHandler({ http: environment });
		const bodies: string[] = [];
		for (const origin of [
			null,
			"http://app.example.com",
			"https://app.example.com:8443",
			"https://app.example.com.evil.com",
			"https://evil.com",
		]) {
			const response = await handler(requestTo("/test/echo", { origin, body: { value: "x" } }));
			bodies.push(`${response.status}|${[...response.headers].join()}|${await response.text()}`);
		}

		expect(new Set(bodies).size).toBe(1);
	});

	it("skips the origin check only where the declaration says exempt", async () => {
		const { environment } = createHarness();
		const response = await toWebHandler({ http: environment })(
			requestTo("/test/callback/google?code=abc", { method: "GET", origin: null }),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ provider: "google", code: "abc" });
	});

	it("ignores query parameters the route does not declare", async () => {
		const { environment } = createHarness();
		const response = await toWebHandler({ http: environment })(
			requestTo("/test/callback/google?code=abc&authuser=0&prompt=consent&hd=example.com", {
				method: "GET",
				origin: null,
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ provider: "google", code: "abc" });
	});

	it("rejects a query parameter that appears twice instead of choosing a value", async () => {
		const { environment } = createHarness();
		const response = await toWebHandler({ http: environment })(
			requestTo("/test/callback/google?code=first&code=second", {
				method: "GET",
				origin: null,
			}),
		);

		expect(response.status).toBe(400);
	});

	it("still rejects a POST body field the route does not declare", async () => {
		const { environment } = createHarness();
		const response = await toWebHandler({ http: environment })(
			requestTo("/test/echo", { body: { value: "x", extra: "y" } }),
		);

		expect(response.status).toBe(400);
	});

	it("counts the request against the route name, not the written path", async () => {
		const { environment, rateLimitRequests } = createHarness();
		const handler = toWebHandler({ http: environment });
		for (const path of ["/test/echo", "//test/echo", "/test/echo/", "/test/ech%6F"]) {
			await handler(requestTo(path, { body: { value: "x" } }));
		}

		expect(rateLimitRequests.map((request) => request.routeName)).toEqual([
			"test.echo",
			"test.echo",
			"test.echo",
			"test.echo",
		]);
	});

	it("rejects the request when a bucket is empty", async () => {
		const { environment } = createHarness({ rateLimitAllows: false });
		const response = await toWebHandler({ http: environment })(
			requestTo("/test/echo", { body: { value: "x" } }),
		);

		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe("30");
		expect(await response.json()).toEqual({
			error: { code: "rate_limited", message: "Too many requests.", retryAfterSeconds: 30 },
		});
	});

	it("says nothing about a wait it cannot express", async () => {
		const { environment } = createHarness();
		const response = await toWebHandler({
			http: {
				...environment,
				rateLimiter: {
					consume: async () => ({ allowed: false, retryAfterSeconds: Number.POSITIVE_INFINITY }),
				},
			},
		})(requestTo("/test/echo", { body: { value: "x" } }));

		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBeNull();
		expect(await response.json()).toEqual({
			error: { code: "rate_limited", message: "Too many requests." },
		});
	});

	it("consumes the account bucket with the identifier the route passes in", async () => {
		const { environment, rateLimitRequests } = createHarness();
		await toWebHandler({ http: environment })(
			requestTo("/test/sign-in", { body: { identifier: "someone@example.com" } }),
		);

		expect(rateLimitRequests.map((request) => request.scope)).toEqual([
			{ kind: "ip_address", ipAddress: null },
			{ kind: "account", accountIdentifier: "someone@example.com" },
		]);
	});

	it("says so when a route declares an account bucket it never consumes", async () => {
		const uncounted = defineRoute({
			name: "test.uncounted",
			method: "POST",
			path: "/test/uncounted",
			input: object({}),
			errors: [] as const,
			caller: "anonymous",
			freshness: "not_required",
			originCheck: "checked",
			rateLimit: { perIpAddress: "none", perAccount: { capacity: 5, refillPerSecond: 0.01 } },
			handler: async () => ({ done: true }),
		});
		const { environment, logs, rateLimitRequests } = createHarness({ routes: [uncounted] });
		const response = await toWebHandler({ http: environment })(requestTo("/test/uncounted"));

		expect(response.status).toBe(200);
		expect(rateLimitRequests).toEqual([]);
		expect(logs).toEqual([
			{
				level: "warn",
				message: "route declares an account rate limit it never consumed",
				fields: { route: "test.uncounted" },
			},
		]);
	});

	it("says so as well when the handler throws without consuming the bucket", async () => {
		const rejecting = defineRoute({
			...COLLIDING_DECLARATION,
			name: "test.rejecting",
			path: "/test/rejecting",
			rateLimit: { perIpAddress: "none", perAccount: { capacity: 5, refillPerSecond: 0.01 } },
			handler: async () => {
				throw new ConcealedError("password_mismatch");
			},
		});
		const { environment, logs } = createHarness({ routes: [rejecting] });
		const response = await toWebHandler({ http: environment })(requestTo("/test/rejecting"));

		expect(response.status).toBe(401);
		expect(logs.map((entry) => entry.message)).toEqual([
			"route declares an account rate limit it never consumed",
			"request rejected",
		]);
	});

	it("stays quiet when the route consumes the account bucket it declares", async () => {
		const { environment, logs } = createHarness();
		await toWebHandler({ http: environment })(
			requestTo("/test/sign-in", { body: { identifier: "someone@example.com" } }),
		);

		expect(logs).toEqual([]);
	});

	it("moves a session token into the cookie instead of the response body", async () => {
		const { environment } = createHarness();
		const response = await toWebHandler({ http: environment })(
			requestTo("/test/sign-in", { body: { identifier: "someone@example.com" } }),
		);

		expect(await response.json()).toEqual({ status: "signed_in" });
		expect(response.headers.getSetCookie()).toEqual([
			"__Host-velve_session=session-token-value; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax; Path=/",
		]);
	});

	it("answers a handler without a return value with 204 and no body", async () => {
		const { environment } = createHarness();
		const response = await toWebHandler({ http: environment })(requestTo("/test/sign-out"));

		expect(response.status).toBe(204);
		expect(await response.text()).toBe("");
		expect(response.headers.getSetCookie()).toEqual([
			"__Host-velve_session=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/",
		]);
	});

	it("resolves the caller from the session cookie", async () => {
		const { environment } = createHarness();
		const response = await toWebHandler({ http: environment })(
			requestTo("/test/session", { method: "GET", cookie: "__Host-velve_session=abc" }),
		);

		expect(await response.json()).toEqual({ userId: "user-of-abc" });
	});

	it("merges every session failure into session_required", async () => {
		const { environment, logs } = createHarness({
			sessionFailure: new ConcealedError("session_absolute_expired"),
		});
		const response = await toWebHandler({ http: environment })(
			requestTo("/test/session", { method: "GET", cookie: "__Host-velve_session=abc" }),
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			error: { code: "session_required", message: "A valid session is required." },
		});
		expect(logs[0]?.fields).toEqual({
			route: "test.session.read",
			reason: "session_absolute_expired",
		});
	});

	it("rejects a request that carries the session cookie twice", async () => {
		const { environment } = createHarness();
		const response = await toWebHandler({ http: environment })(
			requestTo("/test/session", {
				method: "GET",
				cookie: "__Host-velve_session=A; __Host-velve_session=B",
			}),
		);

		expect(response.status).toBe(400);
	});

	it("checks the origin before it reads the cookies", async () => {
		const { environment } = createHarness();
		const response = await toWebHandler({ http: environment })(
			requestTo("/test/session", {
				method: "GET",
				origin: "https://evil.com",
				cookie: "__Host-velve_session=A; __Host-velve_session=B",
			}),
		);

		expect(response.status).toBe(403);
	});

	it("requires a fresh session where the declaration asks for one", async () => {
		const stale = createHarness({ sessionAgeInSeconds: 901 });
		const fresh = createHarness({ sessionAgeInSeconds: 899 });
		const call = requestTo("/test/fresh", { cookie: "__Host-velve_session=abc" });

		expect((await toWebHandler({ http: stale.environment })(call.clone())).status).toBe(403);
		expect((await toWebHandler({ http: fresh.environment })(call)).status).toBe(200);
	});

	it("reads the pending cookie only on a route that declares caller pending", async () => {
		const { environment } = createHarness();
		const handler = toWebHandler({ http: environment });
		const cookie = "__Host-velve_pending=pending-value";

		const accepted = await handler(requestTo("/test/factor/verify", { cookie }));
		const withPendingCookie = await handler(
			requestTo("/test/echo", { cookie, body: { value: "x" } }),
		);
		const withoutCookie = await handler(requestTo("/test/echo", { body: { value: "x" } }));

		expect(await accepted.json()).toEqual({ attemptsRemaining: 5 });
		expect(await withPendingCookie.text()).toBe(await withoutCookie.text());
	});

	it("gives a route declared server_only no HTTP route at all", async () => {
		const { environment } = createHarness();
		const response = await toWebHandler({ http: environment })(
			requestTo("/test/maintenance/sweep"),
		);

		expect(response.status).toBe(404);
	});

	it("answers with JSON wherever there is a body", async () => {
		const { environment } = createHarness();
		const handler = toWebHandler({ http: environment });
		const responses = [
			await handler(requestTo("/test/echo", { body: { value: "hello" } })),
			await handler(requestTo("/test/echo", { origin: "https://evil.com" })),
		];

		for (const response of responses) {
			expect(response.headers.get("Content-Type")).toBe("application/json");
		}
	});

	it("resolves a path written in another case or with an encoded character", async () => {
		const { environment } = createHarness();
		const handler = toWebHandler({ http: environment });

		for (const path of ["/TEST/ECHO", "/Test/Echo", "/test/ech%6F"]) {
			const response = await handler(requestTo(path, { body: { value: "x" } }));
			expect([path, response.status]).toEqual([path, 200]);
		}
	});

	it("refuses to start when two routes answer the same folded path", () => {
		const { environment } = createHarness({
			routes: [
				defineRoute({ ...COLLIDING_DECLARATION, name: "test.collision.lower" }),
				defineRoute({
					...COLLIDING_DECLARATION,
					name: "test.collision.upper",
					path: "/test/COLLISION",
				}),
			],
		});

		expect(() => toWebHandler({ http: environment })).toThrow(/already answers/);
	});

	it("refuses to start when two routes carry the same name", () => {
		const { environment } = createHarness({
			routes: [
				defineRoute(COLLIDING_DECLARATION),
				defineRoute({ ...COLLIDING_DECLARATION, path: "/test/elsewhere" }),
			],
		});

		expect(() => toWebHandler({ http: environment })).toThrow(/declared more than once/);
	});

	it("folds only ASCII case, so a Unicode look-alike does not resolve", async () => {
		const { environment } = createHarness();
		const response = await toWebHandler({ http: environment })(
			requestTo("/test/ech%E2%84%AA", { body: { value: "x" } }),
		);

		expect(response.status).toBe(404);
	});

	it("folds the base path the same way it folds a route path", async () => {
		const { environment } = createHarness();
		const handler = toWebHandler({ http: environment }, { basePath: "/api/auth" });

		for (const path of ["/API/AUTH/test/echo", "/api/auth/TEST/ECHO"]) {
			const response = await handler(requestTo(path, { body: { value: "x" } }));
			expect([path, response.status]).toEqual([path, 200]);
		}
	});

	it("answers a path with broken percent-encoding with 404 rather than the root route", async () => {
		const { environment } = createHarness();
		const response = await toWebHandler({ http: environment })(
			requestTo("/test/%zz", { body: { value: "x" } }),
		);

		expect(response.status).toBe(404);
	});

	it("answers an unknown path with 404 and no body", async () => {
		const { environment } = createHarness();
		const response = await toWebHandler({ http: environment })(requestTo("/test/nothing-here"));

		expect(response.status).toBe(404);
		expect(await response.text()).toBe("");
	});

	it("answers a known path under a wrong method with the same 404", async () => {
		const { environment } = createHarness();
		const response = await toWebHandler({ http: environment })(
			requestTo("/test/echo", { method: "GET" }),
		);

		expect(response.status).toBe(404);
	});

	it("only serves routes below the configured base path", async () => {
		const { environment } = createHarness();
		const handler = toWebHandler({ http: environment }, { basePath: "/api/auth" });

		expect((await handler(requestTo("/api/auth/test/echo", { body: { value: "x" } }))).status).toBe(
			200,
		);
		expect((await handler(requestTo("/test/echo", { body: { value: "x" } }))).status).toBe(404);
		expect(
			(await handler(requestTo("/api/authorize/test/echo", { body: { value: "x" } }))).status,
		).toBe(404);
	});

	it("rejects input the declared schema does not accept", async () => {
		const { environment } = createHarness();
		const handler = toWebHandler({ http: environment });

		for (const body of [{}, { value: 7 }, { value: "x", extra: "y" }]) {
			const response = await handler(requestTo("/test/echo", { body }));
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				error: { code: "invalid_input", message: "The request input is not valid." },
			});
		}
	});

	it("takes the client address only from the adapter, never from a header", async () => {
		const { environment, rateLimitRequests } = createHarness();
		const handler = toWebHandler({ http: environment }, { clientAddress: () => "203.0.113.7" });
		const request = new Request("https://api.example.com/test/echo", {
			method: "POST",
			headers: {
				origin: ALLOWED_ORIGIN,
				"content-type": "application/json",
				"x-forwarded-for": "198.51.100.9",
			},
			body: JSON.stringify({ value: "x" }),
		});
		await handler(request);

		expect(rateLimitRequests[0]?.scope).toEqual({ kind: "ip_address", ipAddress: "203.0.113.7" });
	});

	it("answers a request whose url does not parse", async () => {
		const { environment } = createHarness();
		const request = requestTo("/test/echo", { body: { value: "x" } });
		Object.defineProperty(request, "url", { value: "not a url", configurable: true });

		const response = await toWebHandler({ http: environment })(request);

		expect(response.status).toBe(404);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("Vary")).toBe("Cookie");
	});

	it("answers even when the logger throws", async () => {
		const { environment } = createHarness();
		const response = await toWebHandler({
			http: {
				...environment,
				log: () => {
					throw new Error("the log sink is down");
				},
			},
		})(requestTo("/test/echo", { origin: "https://evil.com", body: { value: "x" } }));

		expect(response.status).toBe(403);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});

	it("says nothing about an unexpected failure", async () => {
		const { environment, logs } = createHarness({ routes: [failingRoute] });
		const response = await toWebHandler({ http: environment })(requestTo("/test/broken"));

		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain("10.0.0.4");
		expect(logs[0]?.level).toBe("error");
		expect(logs[0]?.fields).toEqual({
			route: "test.broken",
			reason: "unhandled_exception",
			cause: "the connection to 10.0.0.4 was refused",
		});
	});
});
