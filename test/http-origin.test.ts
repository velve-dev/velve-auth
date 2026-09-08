import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VelveError } from "../src/core/http/error-map.js";
import { assertOriginAllowed, isOriginAllowed } from "../src/core/http/origin.js";

const ORIGINS = ["https://app.example.com"];

const REJECTED_ORIGINS = [
	null,
	"null",
	"http://app.example.com",
	"https://app.example.com:8443",
	"https://sub.app.example.com",
	"https://app.example.com.evil.com",
	"https://evil.com",
	"https://app.example.com evil",
	"app.example.com",
	"",
];

describe("origin check", () => {
	it("accepts the configured origin", () => {
		expect(isOriginAllowed("https://app.example.com", ORIGINS)).toBe(true);
	});

	it("compares parsed origins, so a trailing path in the configuration does not matter", () => {
		expect(isOriginAllowed("https://app.example.com", ["https://app.example.com/"])).toBe(true);
	});

	it("rejects every origin that differs in scheme, host, port, prefix or suffix", () => {
		for (const origin of REJECTED_ORIGINS) {
			expect(isOriginAllowed(origin, ORIGINS)).toBe(false);
		}
	});

	it("rejects every request when no origin is configured", () => {
		expect(isOriginAllowed("https://app.example.com", [])).toBe(false);
	});

	it("rejects with origin_not_allowed and the same error for every variant", () => {
		for (const origin of REJECTED_ORIGINS) {
			expect(() => {
				assertOriginAllowed(origin, ORIGINS);
			}).toThrow(new VelveError("origin_not_allowed"));
		}
	});

	it("contains no prefix, substring or pattern comparison", () => {
		const source = readFileSync(new URL("../src/core/http/origin.ts", import.meta.url), "utf8");

		for (const forbidden of ["startsWith", "endsWith", "includes", "RegExp", "match", "*"]) {
			expect(source).not.toContain(forbidden);
		}
	});
});
