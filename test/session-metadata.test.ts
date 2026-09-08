import { describe, expect, it } from "vitest";
import { canonicalIpAddress, truncatedIpAddress } from "../src/core/session/ip-address.js";
import {
	DEFAULT_SESSION_METADATA_MODE,
	type SessionMetadata,
	type SessionMetadataMode,
	sessionMetadataFor,
} from "../src/core/session/metadata.js";
import { boundedUserAgent, truncatedUserAgent } from "../src/core/session/user-agent.js";

const CHROME_ON_MACOS =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SAFARI_ON_IOS =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const FIREFOX_ON_WINDOWS =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";
const EDGE_ON_WINDOWS =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";

describe("IPv4 truncation (L-10)", () => {
	it("keeps the /24 network and drops the host", () => {
		expect(truncatedIpAddress("203.0.113.42")).toBe("203.0.113.0/24");
		expect(truncatedIpAddress("10.0.0.1")).toBe("10.0.0.0/24");
	});

	it("maps every host of a network onto the same value", () => {
		const network = new Set(
			["203.0.113.1", "203.0.113.42", "203.0.113.255"].map((address) =>
				truncatedIpAddress(address),
			),
		);

		expect([...network]).toEqual(["203.0.113.0/24"]);
	});

	it("reads an address a proxy wrote as an IPv4-mapped IPv6 address as IPv4", () => {
		expect(truncatedIpAddress("::ffff:203.0.113.42")).toBe("203.0.113.0/24");
		expect(canonicalIpAddress("::ffff:203.0.113.42")).toBe("203.0.113.42");
	});
});

describe("IPv6 truncation (L-10)", () => {
	it("keeps the /64 prefix the rate limiter also uses", () => {
		expect(truncatedIpAddress("2001:db8:1234:5678:9abc:def0:1234:5678")).toBe(
			"2001:db8:1234:5678::/64",
		);
		expect(truncatedIpAddress("2001:db8::1")).toBe("2001:db8::/64");
	});

	it("maps every address inside a prefix onto the same value", () => {
		const prefix = new Set(
			["2001:db8:0:1::1", "2001:db8:0:1:ffff:ffff:ffff:ffff", "2001:db8:0:1::"].map((address) =>
				truncatedIpAddress(address),
			),
		);

		expect([...prefix]).toEqual(["2001:db8:0:1::/64"]);
	});
});

describe("what is not an address", () => {
	it("answers null rather than handing the database a value it would reject", () => {
		for (const text of [
			"",
			"not-an-address",
			"203.0.113",
			"203.0.113.256",
			"203.0.113.1/24",
			"2001:db8::1::2",
			"12345::",
			"203.0.113.1; DROP TABLE velve.session",
		]) {
			expect({ text, truncated: truncatedIpAddress(text) }).toEqual({ text, truncated: null });
			expect(canonicalIpAddress(text)).toBeNull();
		}
	});
});

describe("user agent truncation (L-10)", () => {
	it("keeps browser and system family and nothing that identifies the device", () => {
		expect(truncatedUserAgent(CHROME_ON_MACOS)).toBe("Chrome on macOS");
		expect(truncatedUserAgent(SAFARI_ON_IOS)).toBe("Safari on iOS");
		expect(truncatedUserAgent(FIREFOX_ON_WINDOWS)).toBe("Firefox on Windows");
		expect(truncatedUserAgent(EDGE_ON_WINDOWS)).toBe("Edge on Windows");
	});

	it("carries no version, no build and no device model", () => {
		const truncated = truncatedUserAgent(SAFARI_ON_IOS) ?? "";

		expect(truncated).not.toMatch(/\d/);
		expect(truncated.length).toBeLessThan(32);
	});

	it("answers null for a string that names neither a browser nor a system", () => {
		expect(truncatedUserAgent("curl/8.7.1")).toBeNull();
		expect(truncatedUserAgent("")).toBeNull();
	});

	it("bounds what the full mode stores, because the client chooses the length", () => {
		const stored = boundedUserAgent("A".repeat(4096));

		expect(stored).toHaveLength(512);
		expect(boundedUserAgent("   ")).toBeNull();
	});
});

describe("sessionMetadataFor (L-10, option sessionMetadata)", () => {
	const observed: SessionMetadata = { ipAddress: "203.0.113.42", userAgent: CHROME_ON_MACOS };

	it("truncates unless told otherwise", () => {
		expect(DEFAULT_SESSION_METADATA_MODE).toBe("truncated");
		expect(sessionMetadataFor(DEFAULT_SESSION_METADATA_MODE, observed)).toEqual({
			ipAddress: "203.0.113.0/24",
			userAgent: "Chrome on macOS",
		});
	});

	it("stores the observed values only when full is chosen", () => {
		expect(sessionMetadataFor("full", observed)).toEqual({
			ipAddress: "203.0.113.42",
			userAgent: CHROME_ON_MACOS,
		});
	});

	it("stores nothing at all when none is chosen", () => {
		expect(sessionMetadataFor("none", observed)).toEqual({ ipAddress: null, userAgent: null });
	});

	it("passes a missing value through in every mode", () => {
		const nothing: SessionMetadata = { ipAddress: null, userAgent: null };
		const modes: readonly SessionMetadataMode[] = ["truncated", "full", "none"];

		for (const mode of modes) {
			expect({ mode, ...sessionMetadataFor(mode, nothing) }).toEqual({
				mode,
				ipAddress: null,
				userAgent: null,
			});
		}
	});
});
