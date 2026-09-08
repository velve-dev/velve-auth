import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isOriginAllowed } from "../src/core/http/origin.js";
import { toWebHandler } from "../src/http/index.js";
import { createHarness, requestTo } from "./http-fixtures.js";

const ALLOWED = ["https://app.example.com"];

const ACCEPTED_HEADERS = [
	"https://app.example.com",
	"HTTPS://APP.EXAMPLE.COM",
	"https://app.example.com:443",
	"https://app.example.com/",
];

const REJECTED_HEADERS: readonly (string | null)[] = [
	null,
	"",
	"null",
	"undefined",
	"app.example.com",
	"//app.example.com",
	"http://app.example.com",
	"http://app.example.com:80",
	"https://app.example.com:8443",
	"https://sub.app.example.com",
	"https://app.example.evil.com",
	"https://app.example.com.evil.com",
	"https://app.example.com-evil.com",
	"https://evil.com/https://app.example.com",
	"https://app.example.com@evil.com",
	"https://app.example.com:443@evil.com",
	"https://user:app.example.com@evil.com",
	"https://app.example.com。evil.com",
	"https://app.example.com%2eevil.com",
	"https://xn--pp-uia.example.com",
	"https://аpp.example.com",
	"https://app.example.co",
	"https://app.example.com.",
	"data:text/html,<script></script>",
	"file:///etc/passwd",
	"javascript:https://app.example.com",
	"chrome-extension://abcdefghijklmnopabcdefghijklmnop",
	"blob:https://evil.com/00000000-0000-0000-0000-000000000000",
];

describe("origin check — S-CSRF-2, S-CSRF-3, S-REDIR-5", () => {
	it("accepts only forms that parse to the identical origin", () => {
		for (const header of ACCEPTED_HEADERS) {
			expect([header, isOriginAllowed(header, ALLOWED)]).toEqual([header, true]);
		}
	});

	it("rejects every prefix, suffix, userinfo, homoglyph and opaque variant", () => {
		for (const header of REJECTED_HEADERS) {
			expect([header, isOriginAllowed(header, ALLOWED)]).toEqual([header, false]);
		}
	});

	it("normalises both sides, so a unicode host and its punycode form are one origin", () => {
		expect(isOriginAllowed("https://xn--pp-uia.example.com", ["https://äpp.example.com"])).toBe(
			true,
		);
		expect(isOriginAllowed("https://äpp.example.com", ["https://xn--pp-uia.example.com"])).toBe(
			true,
		);
		expect(isOriginAllowed("https://äpp.example.com", ALLOWED)).toBe(false);
	});

	it("rejects everything when the configured origin itself cannot be parsed", () => {
		for (const configured of ["app.example.com", "*.example.com", "*", ""]) {
			expect([configured, isOriginAllowed("https://app.example.com", [configured])]).toEqual([
				configured,
				false,
			]);
		}
	});

	it("compares origins without a prefix, substring, pattern or wildcard", () => {
		const source = readFileSync(new URL("../src/core/http/origin.ts", import.meta.url), "utf8");

		for (const forbidden of ["startsWith", "endsWith", "includes", "indexOf", "RegExp", "match"]) {
			expect([forbidden, source.includes(forbidden)]).toEqual([forbidden, false]);
		}
	});

	it("answers every rejected variant with the identical status, headers and body", async () => {
		const { environment } = createHarness();
		const handler = toWebHandler({ http: environment });
		const answers = new Set<string>();

		const headerSafe = REJECTED_HEADERS.filter(
			(origin) => origin === null || /^[ -~]*$/.test(origin),
		);

		for (const origin of headerSafe) {
			const response = await handler(requestTo("/test/echo", { origin, body: { value: "x" } }));
			const headers = [...response.headers]
				.map(([name, value]) => `${name}: ${value}`)
				.sort()
				.join("\n");
			answers.add(`${response.status}\n${headers}\n${await response.text()}`);
		}

		expect([...answers]).toEqual([
			[
				"403",
				"cache-control: no-store",
				"content-type: application/json",
				"vary: Cookie",
				'{"error":{"code":"origin_not_allowed","message":"The request origin is not allowed."}}',
			].join("\n"),
		]);
	});

	it("rejects a foreign origin before the rate limiter, the cookies and the handler run", async () => {
		const { environment, rateLimitRequests } = createHarness();
		const response = await toWebHandler({ http: environment })(
			requestTo("/test/sign-in", {
				origin: "https://app.example.com.evil.com",
				cookie: "__Host-velve_session=A; __Host-velve_session=B",
				body: { identifier: "someone@example.com" },
			}),
		);

		expect(response.status).toBe(403);
		expect(response.headers.getSetCookie()).toEqual([]);
		expect(rateLimitRequests).toEqual([]);
	});
});
