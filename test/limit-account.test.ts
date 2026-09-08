import { afterEach, describe, expect, it } from "vitest";
import {
	type Harness,
	NO_LIMIT,
	openLimitHarness,
	readBuckets,
	signInRequest,
} from "./limit-fixtures.js";

const ACCOUNT = { capacity: 5, refillPerSecond: 0.01 };
const CREDENTIAL_CHECK_MILLISECONDS = 15;

let harness: Harness | null = null;

afterEach(async () => {
	await harness?.close();
	harness = null;
});

/** A stand-in for the key derivation a real credential check runs, so a refusal that reaches it
 * is separable from one that does not. */
function afterCredentialCheckDelay(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, CREDENTIAL_CHECK_MILLISECONDS));
}

async function openAccountHarness(): Promise<Harness> {
	harness = await openLimitHarness({
		signIn: { perIpAddress: "none", perAccount: ACCOUNT },
		probe: NO_LIMIT,
		onCredentialCheck: afterCredentialCheckDelay,
		connectionAddress: () => "203.0.113.5",
	});
	return harness;
}

interface Attempt {
	readonly status: number;
	readonly milliseconds: number;
}

async function attemptSignIn(
	open: Harness,
	identifier: string,
	password = "wrong-horse",
): Promise<Attempt> {
	const started = performance.now();
	const response = await open.handle(signInRequest("/sign-in/password", { identifier, password }));
	return { status: response.status, milliseconds: performance.now() - started };
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
		: (sorted[middle] ?? 0);
}

describe("T-RATE-7 — the account counter refuses, and never delays or locks (S-RATE-7)", () => {
	it("refuses the attempt after the capacity for an account that exists and one that does not", async () => {
		const open = await openAccountHarness();

		const statusesOf = async (identifier: string): Promise<number[]> => {
			const statuses: number[] = [];
			for (let attempt = 0; attempt < ACCOUNT.capacity + 1; attempt += 1) {
				statuses.push((await attemptSignIn(open, identifier)).status);
			}
			return statuses;
		};

		const known = await statusesOf("owner@example.com");
		const unknown = await statusesOf("ghost@example.com");

		expect(known).toEqual(unknown);
		expect(known.slice(0, ACCOUNT.capacity)).toEqual(Array(ACCOUNT.capacity).fill(200));
		expect(known.at(-1)).toBe(429);
	});

	it("lets the rightful owner in once the bucket has refilled", async () => {
		const open = await openAccountHarness();
		for (let attempt = 0; attempt < ACCOUNT.capacity + 20; attempt += 1) {
			await attemptSignIn(open, "owner@example.com");
		}

		expect((await attemptSignIn(open, "owner@example.com")).status).toBe(429);
		open.clock.advanceBySeconds(ACCOUNT.capacity / ACCOUNT.refillPerSecond);
		const admitted = await attemptSignIn(open, "owner@example.com", "correct-horse");

		expect(admitted.status).toBe(200);
		expect(
			await (
				await open.handle(
					signInRequest("/sign-in/password", {
						identifier: "owner@example.com",
						password: "correct-horse",
					}),
				)
			).json(),
		).toEqual({ signedIn: true });
	});

	it("answers a refusal faster than it answers a failed sign-in, having run no key derivation", async () => {
		const open = await openAccountHarness();

		const failed: number[] = [];
		for (let attempt = 0; attempt < ACCOUNT.capacity; attempt += 1) {
			const result = await attemptSignIn(open, "owner@example.com");
			expect(result.status).toBe(200);
			failed.push(result.milliseconds);
		}

		const refused: number[] = [];
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const result = await attemptSignIn(open, "owner@example.com");
			expect(result.status).toBe(429);
			refused.push(result.milliseconds);
		}

		expect(median(refused)).toBeLessThan(median(failed));
	});

	it("writes the identifier nowhere in the bucket key", async () => {
		const open = await openAccountHarness();
		await attemptSignIn(open, "Owner@Example.COM");

		const keys = (await readBuckets(open.connection, open.schema)).map((row) => row.bucket_key);

		expect(keys).toHaveLength(1);
		for (const fragment of ["owner", "Owner", "example", "Example", "@"]) {
			expect(keys[0]).not.toContain(fragment);
		}
	});

	it("counts a normalised identifier on one bucket however it was typed", async () => {
		const open = await openAccountHarness();

		for (const identifier of ["owner@example.com", "OWNER@EXAMPLE.COM", "  owner@example.com  "]) {
			await attemptSignIn(open, identifier);
		}

		const keys = (await readBuckets(open.connection, open.schema)).map((row) => row.bucket_key);
		expect(keys).toHaveLength(1);
	});
});
