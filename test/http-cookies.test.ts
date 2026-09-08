import { describe, expect, it } from "vitest";
import {
	assertCookieNamesAreEnumerated,
	type CookieInstruction,
	type CookiePolicy,
	createCookieCollector,
	DEFAULT_COOKIE_NAMES,
	readCookies,
	serializeCookie,
} from "../src/core/http/cookies.js";
import { VelveError } from "../src/core/http/error-map.js";

const POLICY: CookiePolicy = {
	names: DEFAULT_COOKIE_NAMES,
	sameSite: "lax",
	sessionMaximumAgeInSeconds: 2_592_000,
};

describe("cookies", () => {
	it("names the two cookies from the specification", () => {
		expect(DEFAULT_COOKIE_NAMES).toEqual({
			session: "__Host-velve_session",
			pending: "__Host-velve_pending",
		});
	});

	it("writes the session cookie with the fixed attribute set", () => {
		const collector = createCookieCollector(POLICY);
		collector.setSession("token-value");

		expect(collector.collect().map(serializeCookie)).toEqual([
			"__Host-velve_session=token-value; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax; Path=/",
		]);
	});

	it("gives the pending cookie five minutes and the same attributes", () => {
		const collector = createCookieCollector(POLICY);
		collector.setPending("pending-value");

		expect(collector.collect().map(serializeCookie)).toEqual([
			"__Host-velve_pending=pending-value; Max-Age=300; HttpOnly; Secure; SameSite=Lax; Path=/",
		]);
	});

	it("keeps HttpOnly and Secure when the application asks for strict same-site", () => {
		const collector = createCookieCollector({ ...POLICY, sameSite: "strict" });
		collector.setSession("token-value");

		expect(collector.collect().map(serializeCookie)).toEqual([
			"__Host-velve_session=token-value; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict; Path=/",
		]);
	});

	it("writes at most one instruction per cookie", () => {
		const collector = createCookieCollector(POLICY);
		collector.setSession("first");
		collector.clearSession();

		expect(collector.collect()).toHaveLength(1);
		expect(collector.collect()[0]?.maximumAgeInSeconds).toBe(0);
	});

	it("refuses a cookie value that could break out of the header", () => {
		expect(() =>
			serializeCookie({
				name: "__Host-velve_session",
				value: "a; Domain=evil.com",
				maximumAgeInSeconds: 60,
				attributes: "HttpOnly; Secure; SameSite=Lax; Path=/",
			}),
		).toThrow(VelveError);
	});

	it("refuses to set a cookie that is not enumerated", () => {
		expect(() =>
			assertCookieNamesAreEnumerated([
				{
					name: "__Host-velve_extra",
					value: "x",
					maximumAgeInSeconds: 60,
					attributes: "HttpOnly; Secure; SameSite=Lax; Path=/",
				},
			]),
		).toThrow(VelveError);
	});

	it("refuses a cookie name that could carry an attribute of its own", () => {
		expect(() =>
			serializeCookie({
				name: "__Host-velve_session=decoy; Domain=.evil.com",
				value: "x",
				maximumAgeInSeconds: 60,
				attributes: "HttpOnly; Secure; SameSite=Lax; Path=/",
			}),
		).toThrow(VelveError);
	});

	it("writes the enumerated name even when the policy carries another one", () => {
		const collector = createCookieCollector({
			...POLICY,
			names: { session: "__Host-velve_session=decoy; Domain=.evil.com", pending: "__Host-x" },
		});
		collector.setSession("token-value");

		expect(collector.collect().map(serializeCookie)).toEqual([
			"__Host-velve_session=token-value; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax; Path=/",
		]);
	});

	it("refuses every part of the header that was not built from the enumeration", () => {
		for (const maximumAgeInSeconds of [Number.NaN, -1, 1.5, 60.000001, 1e21]) {
			expect(() =>
				serializeCookie({
					name: "__Host-velve_session",
					value: "token",
					maximumAgeInSeconds,
					attributes: "HttpOnly; Secure; SameSite=Lax; Path=/",
				}),
			).toThrow(VelveError);
		}
	});

	it("refuses an attribute set a caller outside TypeScript could still hand over", () => {
		for (const attributes of [
			"HttpOnly; Secure; SameSite=Lax; Path=/; Domain=.evil.com",
			"SameSite=None; Path=/",
		]) {
			const fromJavaScript: CookieInstruction = JSON.parse(
				JSON.stringify({
					name: "__Host-velve_session",
					value: "token",
					maximumAgeInSeconds: 60,
					attributes,
				}),
			);

			expect(() => serializeCookie(fromJavaScript)).toThrow(VelveError);
		}
	});

	it("cannot be talked past by a property that changes between reads", () => {
		let reads = 0;
		const shifting: CookieInstruction = JSON.parse(
			JSON.stringify({
				name: "__Host-velve_session",
				value: "token",
				maximumAgeInSeconds: 60,
				attributes: "HttpOnly; Secure; SameSite=Lax; Path=/",
			}),
		);
		Object.defineProperty(shifting, "attributes", {
			get: () => {
				reads += 1;
				return reads === 1
					? "HttpOnly; Secure; SameSite=Lax; Path=/"
					: "HttpOnly; Secure; SameSite=Lax; Path=/; Domain=.evil.com";
			},
		});

		expect(serializeCookie(shifting)).not.toContain("Domain");
	});

	it("reads the enumerated cookies and ignores the rest", () => {
		expect(
			readCookies("theme=dark; __Host-velve_session=abc; theme=light", DEFAULT_COOKIE_NAMES),
		).toEqual({ session: "abc", pending: null });
	});

	it("rejects a request that carries the same enumerated cookie twice", () => {
		expect(() =>
			readCookies("__Host-velve_session=A; __Host-velve_session=B", DEFAULT_COOKIE_NAMES),
		).toThrow(new VelveError("invalid_input"));
	});
});
