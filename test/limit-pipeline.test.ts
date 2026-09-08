import { afterEach, describe, expect, it } from "vitest";
import type { RouteFloodAlert } from "../src/core/limit/index.js";
import { resolveClientAddress } from "../src/core/limit/index.js";
import {
	type Harness,
	NO_LIMIT,
	openLimitHarness,
	probeRequest,
	readBuckets,
	signInRequest,
} from "./limit-fixtures.js";

let harness: Harness | null = null;

afterEach(async () => {
	await harness?.close();
	harness = null;
});

async function open(options: Parameters<typeof openLimitHarness>[0]): Promise<Harness> {
	harness = await openLimitHarness(options);
	return harness;
}

function statusesOf(responses: readonly Response[]): Readonly<Record<number, number>> {
	const counted: Record<number, number> = {};
	for (const response of responses) {
		counted[response.status] = (counted[response.status] ?? 0) + 1;
	}
	return counted;
}

const ADDRESS_ONLY = { capacity: 5, refillPerSecond: 0.001 };

describe("T-RATE-4 — no client address is still a counted request (S-RATE-4)", () => {
	it("refuses after the capacity and skips no check", async () => {
		const open_ = await open({
			signIn: NO_LIMIT,
			probe: { perIpAddress: ADDRESS_ONLY, perAccount: "none" },
		});
		const attempts = 12;

		const responses: Response[] = [];
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			responses.push(await open_.handle(probeRequest()));
		}

		expect(statusesOf(responses)).toEqual({
			200: ADDRESS_ONLY.capacity,
			429: attempts - ADDRESS_ONLY.capacity,
		});
		expect(open_.limiter.requests).toHaveLength(attempts);
		expect(open_.limiter.requests.every((request) => request.scope.kind === "ip_address")).toBe(
			true,
		);
	});

	it("counts every unresolvable address on one bucket per route", async () => {
		const open_ = await open({
			signIn: NO_LIMIT,
			probe: { perIpAddress: ADDRESS_ONLY, perAccount: "none" },
			clientAddress: (request) => request.headers.get("x-test-address"),
		});

		const spellings = ["fe80::1%eth0", "203.0.113.5:8080", "not-an-ip", "", "[2001:db8::1]"];
		const responses: Response[] = [];
		for (const spelling of spellings) {
			responses.push(await open_.handle(probeRequest({ "x-test-address": spelling })));
		}
		responses.push(await open_.handle(probeRequest({ "x-test-address": "fe80::2%eth0" })));

		expect(statusesOf(responses)).toEqual({ 200: 5, 429: 1 });
		const rows = await readBuckets(open_.connection, open_.schema);
		expect(rows.map((row) => row.bucket_key)).toEqual(["ip|probe|unresolved"]);
	});
});

describe("T-RATE-5 — seven spellings of one path share one bucket (S-RATE-5)", () => {
	const SPELLINGS = [
		"/sign-in/password",
		"//sign-in/password",
		"/sign-in/password/",
		"/./sign-in/password",
		"/sign-in//password",
		"/sign-in/passw%6Frd",
		"/SIGN-IN/PASSWORD",
	];

	it("refuses once the capacity is spent, whatever the mixture", async () => {
		const open_ = await open({
			signIn: { perIpAddress: ADDRESS_ONLY, perAccount: "none" },
			probe: NO_LIMIT,
			clientAddress: () => "203.0.113.5",
		});

		const responses: Response[] = [];
		for (const path of SPELLINGS) {
			responses.push(
				await open_.handle(signInRequest(path, { identifier: "a@example.com", password: "x" })),
			);
		}

		expect(responses).toHaveLength(7);
		expect(statusesOf(responses)).toEqual({ 200: 5, 429: 2 });
		const rows = await readBuckets(open_.connection, open_.schema);
		expect(rows.map((row) => row.bucket_key)).toEqual(["ip|signIn.password|203.0.113.5/32"]);
	});
});

describe("T-RATE-8 — the per-route counter alerts and refuses nothing (S-RATE-8)", () => {
	it("raises the alarm without turning a single request away", async () => {
		const alerts: RouteFloodAlert[] = [];
		const open_ = await open({
			signIn: NO_LIMIT,
			probe: { perIpAddress: { capacity: 1000, refillPerSecond: 1 }, perAccount: "none" },
			config: {
				routeFlood: {
					rule: { capacity: 3, refillPerSecond: 0 },
					onAlert: (alert) => alerts.push(alert),
				},
			},
			clientAddress: () => "203.0.113.5",
		});

		const responses: Response[] = [];
		for (let attempt = 0; attempt < 10; attempt += 1) {
			responses.push(await open_.handle(probeRequest()));
		}

		expect(statusesOf(responses)).toEqual({ 200: 10 });
		expect(alerts.length).toBeGreaterThanOrEqual(1);
		expect(alerts[0]?.routeName).toBe("probe");
		expect(alerts[0]?.addressChecksObserved).toBe(4);
	});

	it("does not let an alert sink that throws cost the caller its answer", async () => {
		const open_ = await open({
			signIn: NO_LIMIT,
			probe: { perIpAddress: { capacity: 1000, refillPerSecond: 1 }, perAccount: "none" },
			config: {
				routeFlood: {
					rule: { capacity: 1, refillPerSecond: 0 },
					onAlert: () => {
						throw new Error("the alert sink is down");
					},
				},
			},
			clientAddress: () => "203.0.113.5",
		});

		const responses = [await open_.handle(probeRequest()), await open_.handle(probeRequest())];

		expect(statusesOf(responses)).toEqual({ 200: 2 });
	});
});

describe("T-RATE-3 — the resolved address is what the counter sees (S-RATE-3)", () => {
	it("admits exactly the capacity from one socket sending a hundred forged headers", async () => {
		const open_ = await open({
			signIn: NO_LIMIT,
			probe: { perIpAddress: ADDRESS_ONLY, perAccount: "none" },
			clientAddress: (request) =>
				resolveClientAddress("203.0.113.1", request.headers.get("x-forwarded-for"), []),
		});

		const responses: Response[] = [];
		for (let attempt = 0; attempt < 100; attempt += 1) {
			responses.push(
				await open_.handle(probeRequest({ "x-forwarded-for": `198.51.100.${attempt % 256}` })),
			);
		}

		expect(statusesOf(responses)).toEqual({
			200: ADDRESS_ONLY.capacity,
			429: 100 - ADDRESS_ONLY.capacity,
		});
		const rows = await readBuckets(open_.connection, open_.schema);
		expect(rows.map((row) => row.bucket_key)).toEqual(["ip|probe|203.0.113.1/32"]);
	});

	it("counts on the address a trusted proxy reports", async () => {
		const open_ = await open({
			signIn: NO_LIMIT,
			probe: { perIpAddress: ADDRESS_ONLY, perAccount: "none" },
			clientAddress: (request) =>
				resolveClientAddress("10.0.0.5", request.headers.get("x-forwarded-for"), ["10.0.0.0/8"]),
		});

		await open_.handle(probeRequest({ "x-forwarded-for": "1.2.3.4, 10.0.0.9" }));

		const rows = await readBuckets(open_.connection, open_.schema);
		expect(rows.map((row) => row.bucket_key)).toEqual(["ip|probe|1.2.3.4/32"]);
	});
});
