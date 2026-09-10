import { describe, expect, it } from "vitest";
import {
	type CookieNames,
	createCookieCollector,
	DEFAULT_COOKIE_NAMES,
	readCookies,
	serializeCookie,
} from "../src/core/http/cookies.js";
import { VelveError } from "../src/core/http/error-map.js";
import { toWebHandler } from "../src/http/index.js";
import { createHarness, requestTo } from "./http-fixtures.js";

const SESSION_COOKIE = "__Host-velve_session";
const PENDING_COOKIE = "__Host-velve_pending";

function parseSetCookie(header: string): { name: string; value: string; attributes: string[] } {
	const [pair, ...attributes] = header.split("; ");
	const separator = (pair ?? "").indexOf("=");
	return {
		name: (pair ?? "").slice(0, separator),
		value: (pair ?? "").slice(separator + 1),
		attributes,
	};
}

async function setCookiesOf(path: string, body: unknown): Promise<readonly string[]> {
	const { environment } = createHarness();
	const response = await toWebHandler({ http: environment })(requestTo(path, { body }));
	return response.headers.getSetCookie();
}

describe("cookie policy — S-COOKIE-1 to S-COOKIE-6", () => {
	/** T-FIX-5: exactly one entry carrying the session name, and the attribute set it fixes. */
	it("names the session cookie exactly and gives it exactly four attributes (S-FIX-5)", async () => {
		const [header, ...rest] = await setCookiesOf("/test/sign-in", {
			identifier: "someone@example.com",
		});

		expect(rest).toEqual([]);
		const cookie = parseSetCookie(header ?? "");
		expect(cookie.name).toBe(SESSION_COOKIE);
		expect(cookie.attributes.filter((attribute) => !attribute.startsWith("Max-Age="))).toEqual([
			"HttpOnly",
			"Secure",
			"SameSite=Lax",
			"Path=/",
		]);
	});

	it("carries the session token and nothing else in the cookie value", async () => {
		const [header] = await setCookiesOf("/test/sign-in", { identifier: "someone@example.com" });
		const cookie = parseSetCookie(header ?? "");

		expect(cookie.value).toBe("session-token-value");
		expect(cookie.value).toMatch(/^[A-Za-z0-9_-]*$/);
	});

	it("gives the pending cookie 300 seconds and the same attribute set", () => {
		const collector = createCookieCollector({
			names: DEFAULT_COOKIE_NAMES,
			sameSite: "lax",
			sessionMaximumAgeInSeconds: 2_592_000,
		});
		collector.setPending("pending-token-value");

		expect(collector.collect().map(serializeCookie)).toEqual([
			`${PENDING_COOKIE}=pending-token-value; Max-Age=300; HttpOnly; Secure; SameSite=Lax; Path=/`,
		]);
	});

	it("never writes Domain, and never drops HttpOnly or Secure, for either same-site value", () => {
		for (const sameSite of ["lax", "strict"] as const) {
			const collector = createCookieCollector({
				names: DEFAULT_COOKIE_NAMES,
				sameSite,
				sessionMaximumAgeInSeconds: 60,
			});
			collector.setSession("token");
			collector.setPending("token");

			for (const header of collector.collect().map(serializeCookie)) {
				expect([header, header.includes("Domain")]).toEqual([header, false]);
				expect([header, header.includes("HttpOnly")]).toEqual([header, true]);
				expect([header, header.includes("Secure")]).toEqual([header, true]);
			}
		}
	});

	it("refuses a configured cookie name that smuggles a Domain attribute (S-COOKIE-2)", () => {
		const smuggled: CookieNames = {
			session: "__Host-velve_session=decoy; Domain=.evil.com; leftover",
			pending: PENDING_COOKIE,
			oauthState: "__Host-velve_oauth_state=decoy; Domain=.evil.com",
		};

		expect(() =>
			serializeCookie({
				name: smuggled.session,
				value: "token",
				maximumAgeInSeconds: 60,
				attributes: "HttpOnly; Secure; SameSite=Lax; Path=/",
			}),
		).toThrow(VelveError);
	});

	it("emits no Domain attribute for any configured cookie name (S-COOKIE-2)", () => {
		const collector = createCookieCollector({
			names: {
				session: "__Host-velve_session=decoy; Domain=.evil.com; leftover",
				pending: PENDING_COOKIE,
				oauthState: "__Host-velve_oauth_state=decoy; Domain=.evil.com",
			},
			sameSite: "lax",
			sessionMaximumAgeInSeconds: 60,
		});
		collector.setSession("token");

		for (const header of collector.collect().map(serializeCookie)) {
			expect([header, header.includes("Domain")]).toEqual([header, false]);
		}
	});

	it("sets no cookie name outside the enumerated set, whatever the configuration says", async () => {
		const { environment } = createHarness();
		const handler = toWebHandler({ http: environment });
		const emitted = new Set<string>();

		for (const request of [
			requestTo("/test/sign-in", { body: { identifier: "someone@example.com" } }),
			requestTo("/test/sign-out"),
			requestTo("/test/echo", { body: { value: "x" } }),
			requestTo("/test/factor/verify", { cookie: `${PENDING_COOKIE}=abc` }),
		]) {
			const response = await handler(request);
			for (const header of response.headers.getSetCookie()) {
				emitted.add(parseSetCookie(header).name);
			}
		}

		expect([...emitted].sort()).toEqual([SESSION_COOKIE]);
		for (const name of emitted) {
			expect([name, [SESSION_COOKIE, PENDING_COOKIE].includes(name)]).toEqual([name, true]);
		}
	});

	/** T-COOKIE-5: the header the row names, both orders, on a route that resolves a session. */
	it("rejects a request that carries either enumerated cookie twice (S-COOKIE-5)", async () => {
		const { environment } = createHarness();
		const handler = toWebHandler({ http: environment });

		for (const cookie of [
			`${SESSION_COOKIE}=A; ${SESSION_COOKIE}=B`,
			`${SESSION_COOKIE}=B; ${SESSION_COOKIE}=A`,
			`theme=dark; ${SESSION_COOKIE}=A; other=1; ${SESSION_COOKIE}=B`,
			`${PENDING_COOKIE}=A; ${PENDING_COOKIE}=B`,
		]) {
			const response = await handler(requestTo("/test/session", { method: "GET", cookie }));
			expect([cookie, response.status]).toEqual([cookie, 400]);
		}
	});

	it("rejects the duplicate on an anonymous route too, so no route picks a value", async () => {
		const { environment } = createHarness();
		const response = await toWebHandler({ http: environment })(
			requestTo("/test/echo", {
				cookie: `${SESSION_COOKIE}=A; ${SESSION_COOKIE}=B`,
				body: { value: "x" },
			}),
		);

		expect(response.status).toBe(400);
	});

	it("resolves no session at all from a duplicated cookie", () => {
		expect(() =>
			readCookies(`${SESSION_COOKIE}=A; ${SESSION_COOKIE}=B`, DEFAULT_COOKIE_NAMES),
		).toThrow(new VelveError("invalid_input"));
	});
});
