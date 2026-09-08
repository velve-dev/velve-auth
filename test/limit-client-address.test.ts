import { describe, expect, it } from "vitest";
import { resolveClientAddress } from "../src/core/limit/index.js";

const PRIVATE_RANGE = ["10.0.0.0/8"];

interface Constellation {
	readonly name: string;
	readonly connectionAddress: string | null;
	readonly forwardedFor: string | null;
	readonly trustedProxies: readonly string[];
	readonly resolved: string | null;
}

/** T-RATE-3: the six constellations the threshold names, and three more the wiring will meet. */
const CONSTELLATIONS: readonly Constellation[] = [
	{
		name: "an empty proxy list ignores the header entirely",
		connectionAddress: "203.0.113.1",
		forwardedFor: "9.9.9.9",
		trustedProxies: [],
		resolved: "203.0.113.1",
	},
	{
		name: "an empty proxy list ignores a whole forged chain",
		connectionAddress: "203.0.113.1",
		forwardedFor: "1.1.1.1, 2.2.2.2, 3.3.3.3",
		trustedProxies: [],
		resolved: "203.0.113.1",
	},
	{
		name: "a trusted proxy hands over the rightmost address it did not vouch for",
		connectionAddress: "10.0.0.5",
		forwardedFor: "1.2.3.4, 10.0.0.9",
		trustedProxies: PRIVATE_RANGE,
		resolved: "1.2.3.4",
	},
	{
		name: "an untrusted connection keeps its own address whatever the header claims",
		connectionAddress: "203.0.113.1",
		forwardedFor: "9.9.9.9",
		trustedProxies: PRIVATE_RANGE,
		resolved: "203.0.113.1",
	},
	{
		name: "a trusted proxy that sends no header keeps its own address",
		connectionAddress: "10.0.0.5",
		forwardedFor: null,
		trustedProxies: PRIVATE_RANGE,
		resolved: "10.0.0.5",
	},
	{
		name: "a chain of nothing but trusted proxies keeps the connection address",
		connectionAddress: "10.0.0.5",
		forwardedFor: "10.0.0.7, 10.0.0.9",
		trustedProxies: PRIVATE_RANGE,
		resolved: "10.0.0.5",
	},
	{
		name: "a proxy named by its bare address is trusted, and only it",
		connectionAddress: "10.0.0.5",
		forwardedFor: "9.9.9.9",
		trustedProxies: ["10.0.0.5"],
		resolved: "9.9.9.9",
	},
	{
		name: "an IPv6 proxy range is trusted by prefix",
		connectionAddress: "2001:db8:0:0:1::9",
		forwardedFor: "9.9.9.9, 2001:db8::2",
		trustedProxies: ["2001:db8::/32"],
		resolved: "9.9.9.9",
	},
	{
		name: "a client that prepends a hop does not get to choose its bucket",
		connectionAddress: "10.0.0.5",
		forwardedFor: "5.5.5.5, 6.6.6.6",
		trustedProxies: PRIVATE_RANGE,
		resolved: "6.6.6.6",
	},
	{
		name: "a forged hop before the real one is skipped even between two proxies",
		connectionAddress: "10.0.0.5",
		forwardedFor: "5.5.5.5, 6.6.6.6, 10.0.0.9",
		trustedProxies: PRIVATE_RANGE,
		resolved: "6.6.6.6",
	},
	{
		name: "no connection address reads no header, however the list is configured",
		connectionAddress: null,
		forwardedFor: "9.9.9.9",
		trustedProxies: PRIVATE_RANGE,
		resolved: null,
	},
];

describe("T-RATE-3 — X-Forwarded-For is read only where a proxy list says so (S-RATE-3)", () => {
	it("reads at least the six constellations the threshold names", () => {
		expect(CONSTELLATIONS.length).toBeGreaterThanOrEqual(6);
	});

	it.each(CONSTELLATIONS)(
		"$name",
		({ connectionAddress, forwardedFor, trustedProxies, resolved }) => {
			expect(resolveClientAddress(connectionAddress, forwardedFor, trustedProxies)).toBe(resolved);
		},
	);

	it("gives one hundred forged headers from one socket one and the same answer", () => {
		const answers = new Set(
			Array.from({ length: 100 }, (_, attempt) =>
				resolveClientAddress("203.0.113.1", `198.51.100.${attempt % 256}`, []),
			),
		);

		expect([...answers]).toEqual(["203.0.113.1"]);
	});

	it("fails closed on a proxy entry that does not parse", () => {
		for (const entry of ["10.0.0.0/", "10.0.0.0/33", "10.0.0.0/8/8", "not-a-range", ""]) {
			expect(resolveClientAddress("10.0.0.5", "9.9.9.9", [entry])).toBe("10.0.0.5");
		}
	});

	it("matches a trusted range however the connection address is spelled", () => {
		expect(resolveClientAddress("::ffff:10.0.0.5", "9.9.9.9", PRIVATE_RANGE)).toBe("9.9.9.9");
	});
});
