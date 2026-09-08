import { describe, expect, it } from "vitest";
import { addressBucketKey } from "../src/core/limit/index.js";

const ROUTE = "signIn.password";
const UNRESOLVED = `ip|${ROUTE}|unresolved`;

interface Vector {
	readonly written: string | null;
	readonly key: string;
}

/** T-RATE-1: the table of architecture 6, plus the spellings a proxy or a scanner writes.
 * Every row states the whole key, so a route name silently dropped from it fails here too. */
const VECTORS: readonly Vector[] = [
	{ written: "2001:db8::1", key: `ip|${ROUTE}|2001:db8::/64` },
	{ written: "2001:0db8:0000:0000:0000:0000:0000:0001", key: `ip|${ROUTE}|2001:db8::/64` },
	{ written: "2001:DB8::1", key: `ip|${ROUTE}|2001:db8::/64` },
	{ written: "2001:0DB8:0000:0000:0000:0000:0000:0001", key: `ip|${ROUTE}|2001:db8::/64` },
	{ written: "2001:db8:0:0:ffff::9999", key: `ip|${ROUTE}|2001:db8::/64` },
	{ written: "203.0.113.5", key: `ip|${ROUTE}|203.0.113.5/32` },
	{ written: "::ffff:203.0.113.5", key: `ip|${ROUTE}|203.0.113.5/32` },
	{ written: "::FFFF:203.0.113.5", key: `ip|${ROUTE}|203.0.113.5/32` },
	{ written: "::ffff:cb00:7105", key: `ip|${ROUTE}|203.0.113.5/32` },
	{ written: " 203.0.113.5 ", key: `ip|${ROUTE}|203.0.113.5/32` },
	{ written: "::1", key: `ip|${ROUTE}|::/64` },
	{ written: "::", key: `ip|${ROUTE}|::/64` },
	{ written: "0.0.0.0", key: `ip|${ROUTE}|0.0.0.0/32` },
	{ written: "", key: UNRESOLVED },
	{ written: "not-an-ip", key: UNRESOLVED },
	{ written: "1.2.3.4, 5.6.7.8", key: UNRESOLVED },
	{ written: "2001:db8::1%eth0", key: UNRESOLVED },
	{ written: "203.0.113.5:8080", key: UNRESOLVED },
	{ written: "[2001:db8::1]", key: UNRESOLVED },
	{ written: "0x7f.0.0.1", key: UNRESOLVED },
	{ written: "2130706433", key: UNRESOLVED },
	{ written: null, key: UNRESOLVED },
];

describe("T-RATE-1 — the address bucket key (S-RATE-1)", () => {
	it("reads at least the twenty vectors the threshold names", () => {
		expect(VECTORS.length).toBeGreaterThanOrEqual(20);
	});

	it.each(VECTORS)("keys $written", ({ written, key }) => {
		expect(addressBucketKey(ROUTE, written)).toBe(key);
	});

	it("separates two routes that see the same address (S-RATE-5)", () => {
		expect(addressBucketKey("signIn.password", "203.0.113.5")).not.toBe(
			addressBucketKey("probe", "203.0.113.5"),
		);
	});

	it("separates two /64 prefixes and joins two addresses inside one (S-RATE-2)", () => {
		expect(addressBucketKey(ROUTE, "2001:db8:0:0:1::1")).toBe(
			addressBucketKey(ROUTE, "2001:db8::dead:beef"),
		);
		expect(addressBucketKey(ROUTE, "2001:db8:0:1::1")).not.toBe(
			addressBucketKey(ROUTE, "2001:db8::1"),
		);
	});

	it("separates two addresses inside one IPv4 /24, which is not a rate prefix (S-RATE-1)", () => {
		expect(addressBucketKey(ROUTE, "203.0.113.5")).not.toBe(addressBucketKey(ROUTE, "203.0.113.6"));
	});
});
