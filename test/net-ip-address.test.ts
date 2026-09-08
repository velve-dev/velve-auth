import { describe, expect, it } from "vitest";
import {
	canonicalIpAddress,
	type IpAddressPrefixLengths,
	ipAddressNetwork,
} from "../src/core/net/ip-address.js";
import { truncatedIpAddress } from "../src/core/session/ip-address.js";

/** 3.9: the rate key is the /64 prefix for IPv6 and the full address for IPv4. */
const RATE_PREFIX_LENGTHS: IpAddressPrefixLengths = { ipv4: 32, ipv6: 64 };

function rateKey(text: string): string | null {
	return ipAddressNetwork(text, RATE_PREFIX_LENGTHS);
}

const SPELLINGS_AND_KEYS: readonly (readonly [string, string | null])[] = [
	["2001:db8::1", "2001:db8::/64"],
	["2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::/64"],
	["2001:DB8::1", "2001:db8::/64"],
	["2001:db8:0:0:ffff::9999", "2001:db8::/64"],
	["::ffff:203.0.113.5", "203.0.113.5/32"],
	["203.0.113.5", "203.0.113.5/32"],
	["::1", "::/64"],
	["0.0.0.0", "0.0.0.0/32"],
	["::", "::/64"],
	["", null],
	["not-an-ip", null],
	["1.2.3.4, 5.6.7.8", null],
	["::FFFF:203.0.113.5", "203.0.113.5/32"],
	["::ffff:c000:0205", "192.0.2.5/32"],
	["0:0:0:0:0:0:0:1", "::/64"],
	["  203.0.113.5  ", "203.0.113.5/32"],
	["fe80::1%eth0", null],
	["010.0.0.1", null],
	["203.0.113.5/24", null],
	["[2001:db8::1]", null],
	["1::2::3", null],
	["2001:db8::00001", null],
];

describe("the rate key folds the spellings of one address (S-RATE-1, T-RATE-1)", () => {
	it.each(SPELLINGS_AND_KEYS)("reads %j as %j", (text, key) => {
		expect(rateKey(text)).toBe(key);
	});

	it("gives the compressed, expanded, upper-case and IPv4-mapped spellings one key each", () => {
		const ipv6 = new Set(
			[
				"2001:db8::1",
				"2001:0db8:0000:0000:0000:0000:0000:0001",
				"2001:DB8::1",
				"2001:db8:0:0:ffff::9999",
			].map(rateKey),
		);
		const ipv4 = new Set(["::ffff:203.0.113.5", "203.0.113.5", "::FFFF:203.0.113.5"].map(rateKey));

		expect([...ipv6]).toEqual(["2001:db8::/64"]);
		expect([...ipv4]).toEqual(["203.0.113.5/32"]);
	});
});

describe("what the prefix lengths decide (S-RATE-1, S-RATE-2)", () => {
	it("puts a thousand addresses of one /64 in one bucket (CVE-2026-45364)", () => {
		const keys = new Set(
			Array.from({ length: 1000 }, (_unused, index) =>
				rateKey(`2001:db8:0:1::${index.toString(16)}`),
			),
		);

		expect([...keys]).toEqual(["2001:db8:0:1::/64"]);
	});

	it("gives a thousand distinct /64 prefixes a thousand buckets", () => {
		const keys = new Set(
			Array.from({ length: 1000 }, (_unused, index) =>
				rateKey(`2001:db8:0:${index.toString(16)}::1`),
			),
		);

		expect(keys.size).toBe(1000);
	});

	it("keeps every IPv4 host apart, which the session /24 does not", () => {
		expect(rateKey("203.0.113.1")).not.toBe(rateKey("203.0.113.2"));
		expect(truncatedIpAddress("203.0.113.1")).toBe(truncatedIpAddress("203.0.113.2"));
	});
});

describe("session metadata truncation is unchanged (L-10)", () => {
	it("still writes the /24 network for IPv4 and the /64 network for IPv6", () => {
		expect(truncatedIpAddress("203.0.113.42")).toBe("203.0.113.0/24");
		expect(truncatedIpAddress("::ffff:203.0.113.42")).toBe("203.0.113.0/24");
		expect(truncatedIpAddress("2001:db8:1234:5678:9abc:def0:1234:5678")).toBe(
			"2001:db8:1234:5678::/64",
		);
	});
});

describe("canonicalIpAddress", () => {
	it("answers the text PostgreSQL inet gives back", () => {
		expect(canonicalIpAddress("2001:0DB8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1");
		expect(canonicalIpAddress("::ffff:203.0.113.5")).toBe("203.0.113.5");
		expect(canonicalIpAddress("not-an-ip")).toBeNull();
	});
});
