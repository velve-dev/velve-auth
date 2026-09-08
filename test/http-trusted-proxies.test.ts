import { describe, expect, it } from "vitest";
import type { RateLimitScope } from "../src/core/http/rate-limit.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { ALLOWED_ORIGIN, createHarness, signInRoute } from "./http-fixtures.js";

const PROXY = "203.0.113.9";
const CLIENT = "198.51.100.7";
const FORWARDED = `${CLIENT}, ${PROXY}`;

interface Observed {
	readonly addresses: readonly (string | null)[];
	readonly request: (forwardedFor: string | null) => Promise<void>;
}

function observing(trustedProxies: readonly string[], connectionAddress: string | null): Observed {
	const harness = createHarness({ routes: [signInRoute], trustedProxies });
	const handler = toWebHandler(
		{ http: harness.environment },
		{ connectionAddress: () => connectionAddress },
	);

	return {
		get addresses() {
			return harness.rateLimitRequests
				.map((request) => request.scope)
				.filter((scope): scope is Extract<RateLimitScope, { kind: "ip_address" }> => {
					return scope.kind === "ip_address";
				})
				.map((scope) => scope.ipAddress);
		},
		request: async (forwardedFor) => {
			const headers = new Headers({ origin: ALLOWED_ORIGIN, "content-type": "application/json" });
			if (forwardedFor !== null) {
				headers.set("x-forwarded-for", forwardedFor);
			}
			await handler(
				new Request("https://api.example.com/test/sign-in", {
					method: "POST",
					headers,
					body: JSON.stringify({ identifier: "someone" }),
				}),
			);
		},
	};
}

/**
 * S-RATE-3 and A.2. `resolveClientAddress` was written and tested against T-RATE-3, `BaseConfig`
 * declared `trustedProxies`, and nothing joined them: every request shared one bucket per route
 * because `clientAddress` defaulted to `() => null`.
 */
describe("the forwarded address counts only behind a trusted proxy (S-RATE-3)", () => {
	it("counts the connection address when no proxy is trusted, over two requests", async () => {
		const observed = observing([], PROXY);

		await observed.request(FORWARDED);
		await observed.request(null);

		expect(observed.addresses).toHaveLength(2);
		expect(observed.addresses).toStrictEqual([PROXY, PROXY]);
	});

	it("counts the forwarded address when the connection is from a trusted range", async () => {
		const observed = observing(["203.0.113.0/24"], PROXY);

		await observed.request(FORWARDED);

		expect(observed.addresses).toHaveLength(1);
		expect(observed.addresses).toStrictEqual([CLIENT]);
	});

	it("counts the connection address when a trusted proxy forwards nothing", async () => {
		const observed = observing(["203.0.113.0/24"], PROXY);

		await observed.request(null);

		expect(observed.addresses).toHaveLength(1);
		expect(observed.addresses).toStrictEqual([PROXY]);
	});

	it("keeps two clients behind one trusted proxy in two buckets", async () => {
		const observed = observing(["203.0.113.0/24"], PROXY);

		await observed.request(`${CLIENT}, ${PROXY}`);
		await observed.request(`192.0.2.4, ${PROXY}`);

		expect(observed.addresses).toHaveLength(2);
		expect(new Set(observed.addresses).size).toBe(2);
	});

	it("ignores a header from a connection the list does not cover", async () => {
		const observed = observing(["10.0.0.0/8"], PROXY);

		await observed.request(FORWARDED);

		expect(observed.addresses).toHaveLength(1);
		expect(observed.addresses).toStrictEqual([PROXY]);
	});
});
