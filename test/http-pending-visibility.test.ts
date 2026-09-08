import { describe, expect, it } from "vitest";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { type AnyRoute, defineRoute, readsPendingCookie } from "../src/core/http/route.js";
import { object } from "../src/core/http/validators.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { ALLOWED_ORIGIN, createHarness, requestTo } from "./http-fixtures.js";

const PENDING_COOKIE = `${DEFAULT_COOKIE_NAMES.pending}=${"p".repeat(43)}`;
const NOTHING_TO_REPORT = { token: null, pending: null };

const reportingRoute = defineRoute({
	name: "test.pending.read",
	method: "GET",
	path: "/test/pending",
	input: object({}),
	errors: [] as const,
	caller: "anonymous",
	freshness: "not_required",
	originCheck: "checked",
	rateLimit: { perIpAddress: "none", perAccount: "none" },
	pendingCookie: "readable",
	handler: async (_input, context) => ({
		token: context.pendingToken,
		pending: context.pending,
	}),
});

const verifyingRoute = defineRoute({
	name: "test.factor.totp.verify",
	method: "POST",
	path: "/test/factor/totp/verify",
	input: object({}),
	errors: ["invalid_pending_authentication"] as const,
	caller: "pending",
	freshness: "not_required",
	originCheck: "checked",
	rateLimit: { perIpAddress: "none", perAccount: "none" },
	handler: async (_input, context) => ({
		token: context.pendingToken,
		userId: context.pending?.userId ?? null,
	}),
});

const unrelatedRoute = defineRoute({
	name: "test.unrelated",
	method: "GET",
	path: "/test/unrelated",
	input: object({}),
	errors: [] as const,
	caller: "anonymous",
	freshness: "not_required",
	originCheck: "checked",
	rateLimit: { perIpAddress: "none", perAccount: "none" },
	handler: async (_input, context) => ({
		token: context.pendingToken,
		pending: context.pending,
	}),
});

const ROUTES: readonly AnyRoute[] = [reportingRoute, verifyingRoute, unrelatedRoute];

function handlerFor(): (request: Request) => Promise<Response> {
	return toWebHandler({ http: createHarness({ routes: ROUTES }).environment });
}

async function bodyOf(path: string, method: string, cookie?: string): Promise<unknown> {
	const answer = await handlerFor()(
		requestTo(path, {
			method,
			origin: ALLOWED_ORIGIN,
			...(cookie === undefined ? {} : { cookie }),
			...(method === "GET" ? {} : { body: {} }),
		}),
	);
	return answer.json();
}

describe("cookie visibility is declared apart from caller authority (E-335, S-CACHE-4)", () => {
	it("marks three routes and reads the cookie for exactly the two that declare it", () => {
		const readable = ROUTES.filter((route) => readsPendingCookie(route)).map((route) => route.name);

		expect(ROUTES).toHaveLength(3);
		expect(readable).toStrictEqual(["test.pending.read", "test.factor.totp.verify"]);
	});

	it('derives readable from `caller: "pending"` without the declaration saying so', () => {
		expect(verifyingRoute.pendingCookie).toBe("readable");
		expect(unrelatedRoute.pendingCookie).toBe("hidden");
	});

	it("refuses a declaration that is authorised by the state and hides its cookie", () => {
		const contradiction = () =>
			defineRoute({
				name: "test.contradiction",
				method: "POST",
				path: "/test/contradiction",
				input: object({}),
				errors: [] as const,
				caller: "pending",
				freshness: "not_required",
				originCheck: "checked",
				rateLimit: { perIpAddress: "none", perAccount: "none" },
				pendingCookie: "hidden",
				handler: async () => undefined,
			});

		expect(contradiction).toThrow(/cannot hide its cookie/);
	});

	it("hands a readable route the token and no authority", async () => {
		expect(await bodyOf("/test/pending", "GET", PENDING_COOKIE)).toStrictEqual({
			token: "p".repeat(43),
			pending: null,
		});
	});

	it("hands a pending-caller route both the token and the resolved account", async () => {
		expect(await bodyOf("/test/factor/totp/verify", "POST", PENDING_COOKIE)).toStrictEqual({
			token: "p".repeat(43),
			userId: `user-of-${"p".repeat(43)}`,
		});
	});

	it("answers a hidden route exactly as if the cookie were absent", async () => {
		expect(await bodyOf("/test/unrelated", "GET", PENDING_COOKIE)).toStrictEqual(NOTHING_TO_REPORT);
		expect(await bodyOf("/test/unrelated", "GET")).toStrictEqual(NOTHING_TO_REPORT);
	});

	it("reports nothing to a readable route when the cookie is absent", async () => {
		expect(await bodyOf("/test/pending", "GET")).toStrictEqual(NOTHING_TO_REPORT);
	});
});
