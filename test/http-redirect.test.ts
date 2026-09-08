import { describe, expect, expectTypeOf, it } from "vitest";
import { VelveError } from "../src/core/http/error-map.js";
import {
	type RedirectPath,
	readRedirectPath,
	redirectTo,
	toRedirectPath,
} from "../src/core/http/redirect.js";
import { defineRoute } from "../src/core/http/route.js";
import { object } from "../src/core/http/validators.js";
import { toWebHandler } from "../src/http/index.js";
import { createHarness, requestTo } from "./http-fixtures.js";

const REJECTED_TARGETS = [
	"https://evil.com",
	"//evil.com",
	"/\\evil.com",
	"evil.com",
	"javascript:alert(1)",
	"/app\r\nSet-Cookie: a=b",
	"/app?token=SECRET",
	"/app#token=SECRET",
	"",
];

const redirectingRoute = defineRoute({
	name: "test.redirecting",
	method: "POST",
	path: "/test/redirecting",
	input: object({}),
	errors: [] as const,
	caller: "anonymous",
	freshness: "not_required",
	originCheck: "checked",
	rateLimit: { perIpAddress: "none", perAccount: "none" },
	handler: async () => ({
		...redirectTo(toRedirectPath("/app/welcome")),
		sessionToken: "session-token-value",
	}),
});

describe("redirects", () => {
	it("answers with 302, the path and the session cookie", async () => {
		const { environment } = createHarness({ routes: [redirectingRoute] });
		const response = await toWebHandler({ http: environment })(requestTo("/test/redirecting"));

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/app/welcome");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.text()).toBe("");
		expect(response.headers.getSetCookie()).toEqual([
			"__Host-velve_session=session-token-value; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax; Path=/",
		]);
	});

	it("puts no token into the Location value", async () => {
		const { environment } = createHarness({ routes: [redirectingRoute] });
		const response = await toWebHandler({ http: environment })(requestTo("/test/redirecting"));

		expect(response.headers.get("Location")).not.toContain("session-token-value");
	});

	it("refuses a target that is not a path without a host and without a query", () => {
		for (const target of REJECTED_TARGETS) {
			expect(() => toRedirectPath(target)).toThrow(VelveError);
			expect(() => readRedirectPath({ redirectToPath: target })).toThrow(VelveError);
		}
	});

	it("carries the target as a minted path and never as a plain string", () => {
		expectTypeOf(toRedirectPath("/app")).toEqualTypeOf<RedirectPath>();
		expectTypeOf<Parameters<typeof redirectTo>[0]>().toEqualTypeOf<RedirectPath>();
		expectTypeOf(redirectTo(toRedirectPath("/app")).redirectToPath).toEqualTypeOf<RedirectPath>();
	});

	it("reads no redirect out of an ordinary output", () => {
		expect(readRedirectPath({ status: "signed_in" })).toBeNull();
		expect(readRedirectPath(undefined)).toBeNull();
	});
});
