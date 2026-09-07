import { describe, expect, it } from "vitest";
import { ConcealedError } from "../src/core/http/error-map.js";
import { toWebHandler } from "../src/http/index.js";
import { ALLOWED_ORIGIN, createHarness, failingRoute, requestTo } from "./http-fixtures.js";

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
		expect(await response.json()).toEqual({
			error: { code: "rate_limited", message: "Too many requests.", retryAfterSeconds: 30 },
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

	it("says nothing about an unexpected failure", async () => {
		const { environment, logs } = createHarness({ routes: [failingRoute] });
		const response = await toWebHandler({ http: environment })(requestTo("/test/broken"));

		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain("10.0.0.4");
		expect(logs[0]?.level).toBe("error");
	});
});
