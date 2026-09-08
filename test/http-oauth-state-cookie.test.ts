import { describe, expect, it } from "vitest";
import {
	assertCookieNamesAreEnumerated,
	type CookiePolicy,
	type CookieSameSite,
	createCookieCollector,
	DEFAULT_COOKIE_NAMES,
	readCookies,
	serializeCookie,
} from "../src/core/http/cookies.js";

const BOTH_SAME_SITE_SETTINGS: readonly CookieSameSite[] = ["lax", "strict"];

function policyWith(sameSite: CookieSameSite): CookiePolicy {
	return { names: DEFAULT_COOKIE_NAMES, sameSite, sessionMaximumAgeInSeconds: 2_592_000 };
}

function headersFor(sameSite: CookieSameSite): readonly string[] {
	const collector = createCookieCollector(policyWith(sameSite));
	collector.setSession("s".repeat(43));
	collector.setOAuthState("o".repeat(43));
	return collector.collect().map(serializeCookie);
}

describe("the state pointer is the third enumerated cookie (S-COOKIE-6, 3.10)", () => {
	it("names three cookies and no more", () => {
		expect(Object.keys(DEFAULT_COOKIE_NAMES).sort()).toStrictEqual([
			"oauthState",
			"pending",
			"session",
		]);
		expect(DEFAULT_COOKIE_NAMES.oauthState).toBe("__Host-velve_oauth_state");
	});

	it("accepts the third name where an unenumerated one is refused", () => {
		const collector = createCookieCollector(policyWith("lax"));
		collector.setOAuthState("o".repeat(43));
		const written = collector.collect();

		expect(written).toHaveLength(1);
		expect(() => {
			assertCookieNamesAreEnumerated(written);
		}).not.toThrow();
		expect(() => {
			assertCookieNamesAreEnumerated([
				{
					name: "__Host-velve_unknown",
					value: "x",
					maximumAgeInSeconds: 60,
					attributes: "HttpOnly; Secure; SameSite=Lax; Path=/",
				},
			]);
		}).toThrow();
	});

	it("reads the third name back out of a request header", () => {
		const values = readCookies(
			`${DEFAULT_COOKIE_NAMES.oauthState}=pointer; theme=dark`,
			DEFAULT_COOKIE_NAMES,
		);

		expect(values).toStrictEqual({ session: null, pending: null, oauthState: "pointer" });
	});

	it("clears the pointer with an empty value and no lifetime", () => {
		const collector = createCookieCollector(policyWith("strict"));
		collector.clearOAuthState();

		expect(collector.collect().map(serializeCookie)).toStrictEqual([
			"__Host-velve_oauth_state=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/",
		]);
	});
});

/**
 * The callback is a top-level cross-site GET (5.9 a), which a `SameSite=Strict` cookie is not sent
 * on, so the pointer would be missing exactly where it is read. `strict` stays legal for the
 * session cookie and the pointer does not follow it.
 */
describe('`sameSite: "strict"` stays legal, and the pointer does not take it', () => {
	it("keeps Lax on the pointer under both settings, over two settings that are not one", () => {
		const attributesOfPointer = BOTH_SAME_SITE_SETTINGS.map(
			(sameSite) =>
				headersFor(sameSite).find((header) => header.startsWith(DEFAULT_COOKIE_NAMES.oauthState)) ??
				"",
		);

		expect(BOTH_SAME_SITE_SETTINGS).toHaveLength(2);
		expect(attributesOfPointer.filter((header) => header.includes("SameSite=Lax"))).toHaveLength(2);
		expect(
			attributesOfPointer.filter((header) => header.includes("SameSite=Strict")),
		).toStrictEqual([]);
	});

	it("still applies the chosen setting to the session cookie", () => {
		const sessionHeaders = BOTH_SAME_SITE_SETTINGS.map(
			(sameSite) =>
				headersFor(sameSite).find((header) => header.startsWith(DEFAULT_COOKIE_NAMES.session)) ??
				"",
		);

		expect(sessionHeaders).toHaveLength(2);
		expect(sessionHeaders[0]).toContain("SameSite=Lax");
		expect(sessionHeaders[1]).toContain("SameSite=Strict");
	});

	it("gives the pointer ten minutes, so it outlives the row it points at", () => {
		const header =
			headersFor("lax").find((line) => line.startsWith(DEFAULT_COOKIE_NAMES.oauthState)) ?? "";

		expect(header).toContain("Max-Age=600");
	});
});
