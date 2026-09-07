import { describe, expect, it } from "vitest";
import { ConcealedError } from "../src/core/http/error-map.js";
import { type AnyRoute, defineRoute } from "../src/core/http/route.js";
import { object, string } from "../src/core/http/validators.js";
import { toWebHandler } from "../src/http/index.js";
import { createHarness, failingRoute, requestTo } from "./http-fixtures.js";

const CANARY = "canary-8f2c1d";

const brokenCookieRoute = defineRoute({
	name: "test.brokenCookie",
	method: "POST",
	path: "/test/broken-cookie",
	input: object({}),
	errors: [] as const,
	caller: "anonymous",
	freshness: "not_required",
	originCheck: "checked",
	rateLimit: { perIpAddress: "none", perAccount: "none" },
	handler: async () => ({ sessionToken: "a; Domain=evil.com" }),
});

const reflectingRoute = defineRoute({
	name: "test.reflecting",
	method: "POST",
	path: "/test/reflecting",
	input: object({ value: string() }),
	errors: ["invalid_input"] as const,
	caller: "anonymous",
	freshness: "not_required",
	originCheck: "checked",
	rateLimit: { perIpAddress: "none", perAccount: "none" },
	handler: async () => ({ accepted: true }),
});

const EXTRA_ROUTES: readonly AnyRoute[] = [brokenCookieRoute, reflectingRoute, failingRoute];

async function everyReachableResponse(): Promise<readonly { label: string; response: Response }[]> {
	const answers: { label: string; response: Response }[] = [];

	const base = createHarness();
	const baseHandler = toWebHandler({ http: base.environment });
	const calls: readonly (readonly [string, Request])[] = [
		["200 handler output", requestTo("/test/echo", { body: { value: "hello" } })],
		["204 handler without output", requestTo("/test/sign-out")],
		["400 input rejected", requestTo("/test/echo", { body: { value: 7 } })],
		["400 body is not JSON", requestTo("/test/echo", { body: undefined })],
		[
			"400 duplicate cookie",
			requestTo("/test/echo", {
				cookie: "__Host-velve_session=A; __Host-velve_session=B",
				body: { value: "x" },
			}),
		],
		["403 foreign origin", requestTo("/test/echo", { origin: "https://evil.com" })],
		["404 unknown path", requestTo("/test/nothing-here")],
		["404 wrong method", requestTo("/test/echo", { method: "GET" })],
		["404 server_only route", requestTo("/test/maintenance/sweep")],
		[
			"200 exempt route",
			requestTo("/test/callback/google?code=abc", {
				method: "GET",
				origin: null,
			}),
		],
	];
	for (const [label, request] of calls) {
		answers.push({ label, response: await baseHandler(request) });
	}

	const noSession = createHarness({ sessionFailure: new ConcealedError("session_not_found") });
	answers.push({
		label: "401 session required",
		response: await toWebHandler({ http: noSession.environment })(
			requestTo("/test/session", { method: "GET", cookie: "__Host-velve_session=abc" }),
		),
	});

	const stale = createHarness({ sessionAgeInSeconds: 100_000 });
	answers.push({
		label: "403 freshness required",
		response: await toWebHandler({ http: stale.environment })(
			requestTo("/test/fresh", { cookie: "__Host-velve_session=abc" }),
		),
	});

	const limited = createHarness({ rateLimitAllows: false });
	answers.push({
		label: "429 rate limited",
		response: await toWebHandler({ http: limited.environment })(
			requestTo("/test/echo", { body: { value: "x" } }),
		),
	});

	const extra = createHarness({ routes: EXTRA_ROUTES });
	const extraHandler = toWebHandler({ http: extra.environment });
	answers.push({
		label: "500 handler threw",
		response: await extraHandler(requestTo("/test/broken")),
	});
	answers.push({
		label: "500 cookie could not be serialised",
		response: await extraHandler(requestTo("/test/broken-cookie")),
	});
	answers.push({
		label: "200 with a reflected input value in the request",
		response: await extraHandler(requestTo("/test/reflecting", { body: { value: CANARY } })),
	});
	answers.push({
		label: "400 with a reflected input value in the request",
		response: await extraHandler(requestTo("/test/reflecting", { body: { wrong: CANARY } })),
	});

	return answers;
}

describe("response uniformity — L-6, S-CACHE-1, S-REDIR-3, S-REDIR-4, S-REDIR-7", () => {
	it("puts Cache-Control: no-store and Vary: Cookie on every response the handler can produce", async () => {
		for (const { label, response } of await everyReachableResponse()) {
			expect([label, response.headers.get("Cache-Control"), response.headers.get("Vary")]).toEqual([
				label,
				"no-store",
				"Cookie",
			]);
		}
	});

	it("covers every status the handler can produce", async () => {
		const statuses = (await everyReachableResponse()).map(({ response }) => response.status);

		expect([...new Set(statuses)].sort()).toEqual([200, 204, 400, 401, 403, 404, 429, 500]);
	});

	it("answers with application/json wherever there is a body, and with no body otherwise", async () => {
		for (const { label, response } of await everyReachableResponse()) {
			const contentType = response.headers.get("Content-Type");
			const body = await response.text();
			expect([label, body === "", contentType]).toEqual([
				label,
				body === "",
				body === "" ? null : "application/json",
			]);
			expect([label, response.status === 204 || response.status === 404 ? body : ""]).toEqual([
				label,
				"",
			]);
		}
	});

	it("never emits a Location header", async () => {
		for (const { label, response } of await everyReachableResponse()) {
			expect([label, response.headers.get("Location")]).toEqual([label, null]);
		}
	});

	it("never reflects an input value in a response body", async () => {
		for (const { label, response } of await everyReachableResponse()) {
			expect([label, (await response.text()).includes(CANARY)]).toEqual([label, false]);
		}
	});

	it("never leaks an internal reason or an exception message to the caller", async () => {
		const secrets = [
			"10.0.0.4",
			"session_not_found",
			"cookie_absent",
			"unhandled_exception",
			"Domain=evil.com",
		];

		for (const { label, response } of await everyReachableResponse()) {
			const body = await response.text();
			for (const secret of secrets) {
				expect([label, secret, body.includes(secret)]).toEqual([label, secret, false]);
			}
		}
	});

	it("produces exactly one error envelope shape for every failure", async () => {
		const shapes = new Set<string>();

		for (const { response } of await everyReachableResponse()) {
			const body = await response.text();
			if (body === "" || response.status < 400) {
				continue;
			}
			shapes.add(Object.keys(JSON.parse(body).error).sort().join(","));
		}

		expect([...shapes].sort()).toEqual(["code,message", "code,message,retryAfterSeconds"]);
	});
});
