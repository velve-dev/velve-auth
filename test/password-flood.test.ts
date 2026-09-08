import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { rootKeyProvider } from "../src/core/keys/index.js";
import { deriveArgon2, selectArgon2Engine } from "../src/core/password/argon2.js";
import { resolvePasswordConfig } from "../src/core/password/config.js";
import {
	createPasswordCredentialRepository,
	type PasswordCredentialRow,
	sealPhc,
} from "../src/core/password/credential.js";
import {
	createKdfSemaphore,
	DEFAULT_WAIT_LIMIT_IN_MILLISECONDS,
	type KdfSemaphore,
} from "../src/core/password/semaphore.js";
import {
	checkPassword,
	createDummyCredential,
	type PasswordEnvironment,
} from "../src/core/password/verify.js";
import { generateRootKey } from "./keys-fixtures.js";
import { drawTestPassword, type StoredHashes, storedHashesFor } from "./password-fixtures.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const PASSWORD = drawTestPassword();
const CHEAP_ARGON2ID = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;

interface Harness {
	readonly environment: PasswordEnvironment;
	readonly semaphore: KdfSemaphore;
	readonly derivations: () => number;
	readonly hold: () => Promise<void>;
	readonly release: () => void;
}

let stored: StoredHashes;

async function createHarness(limit: number, waitLimitInMilliseconds: number): Promise<Harness> {
	const keys = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });
	const config = resolvePasswordConfig({ argon2id: CHEAP_ARGON2ID });
	const sealed = await sealPhc(keys, stored.byScheme.argon2id);
	const row: PasswordCredentialRow = {
		userId: USER_ID,
		phc: sealed.ciphertext,
		keyVersion: sealed.keyVersion,
		scheme: "argon2id",
	};

	const driver: Driver = {
		async query<T>(sql: string, parameters: unknown[]): Promise<T[]> {
			if (sql.includes("SELECT") && parameters[0] === USER_ID) {
				return [
					{
						user_id: row.userId,
						phc: row.phc,
						key_version: row.keyVersion,
						scheme: row.scheme,
					},
				] as T[];
			}
			// The upsert returns the row it wrote; a repository that is told nothing was written
			// refuses, because that is what a false `DO UPDATE … WHERE` looks like (E-185).
			return (sql.includes("INSERT") ? [{ user_id: parameters[0] }] : []) as T[];
		},
		transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T> {
			return fn(driver);
		},
	};

	const inner = createKdfSemaphore({ limit, waitLimitInMilliseconds });
	let derivations = 0;
	let release = (): void => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});

	// A derivation that is held open turns the semaphore into a queue without making the test wait
	// on a real Argon2id call; the count is what S-DOS-4 is about, not the arithmetic.
	const semaphore: KdfSemaphore = {
		run(work) {
			return inner.run(async () => {
				derivations += 1;
				await gate;
				return work();
			});
		},
		get inFlight() {
			return inner.inFlight;
		},
		get peakInFlight() {
			return inner.peakInFlight;
		},
		get waiting() {
			return inner.waiting;
		},
	};

	return {
		environment: {
			config,
			keys,
			credentials: createPasswordCredentialRepository({ driver, keys }),
			semaphore,
			dummy: await createDummyCredential(keys, config),
		},
		semaphore,
		derivations: () => derivations,
		hold: () => Promise.resolve(),
		release: () => {
			release();
		},
	};
}

beforeEach(async () => {
	stored = stored ?? (await storedHashesFor(PASSWORD));
}, 120_000);

describe("S-DOS-3, S-DOS-4 — a flood is refused, not queued forever", () => {
	it("keeps the five-second wait limit as the default of the semaphore", () => {
		expect(DEFAULT_WAIT_LIMIT_IN_MILLISECONDS).toBe(5000);
	});

	it("refuses every sign-in that has waited out the limit and runs no derivation for it", async () => {
		const harness = await createHarness(1, 100);

		const settled = Promise.allSettled(
			Array.from({ length: 500 }, (_, index) =>
				checkPassword(
					{ userId: index % 2 === 0 ? USER_ID : null, plaintext: PASSWORD },
					harness.environment,
				),
			),
		);

		await new Promise((resolve) => setTimeout(resolve, 400));
		harness.release();
		const outcomes = await settled;

		expect(outcomes).toHaveLength(500);
		expect(harness.derivations(), "only the holder ever derived").toBe(1);

		const refused = outcomes.filter((outcome) => outcome.status === "rejected");
		expect(refused).toHaveLength(499);
		for (const outcome of refused) {
			expect(outcome.reason).toMatchObject({ code: "rate_limited", httpStatus: 429 });
		}
	}, 120_000);

	// The case above substitutes a held-open promise for the derivation, so it proves the
	// semaphore's bookkeeping and cannot fail on the requirement: a derivation that never returns
	// to the timer phase serves the whole flood without the wait limit ever coming due. This one
	// runs the real derivation on whichever engine the runtime selected, which is the accelerator
	// wherever `hash-wasm` is installed (E-186, repository rules section 5).
	it("fires the wait limit against the derivation the runtime actually uses", async () => {
		const engine = await selectArgon2Engine(0x13);
		const semaphore = createKdfSemaphore({ limit: 1, waitLimitInMilliseconds: 40 });
		const request = {
			variant: "argon2id",
			password: new Uint8Array(16),
			salt: new Uint8Array(16),
			memoryKiB: 1024,
			iterations: 2,
			parallelism: 1,
			version: 0x13,
			hashBytes: 32,
		} as const;

		let dueDuringTheFlood = false;
		const timer = setTimeout(() => {
			dueDuringTheFlood = true;
		}, 20);

		const settled = await Promise.allSettled(
			Array.from({ length: 60 }, () => semaphore.run(() => deriveArgon2(request))),
		);
		clearTimeout(timer);

		const refused = settled.filter((outcome) => outcome.status === "rejected");

		expect(settled).toHaveLength(60);
		expect(dueDuringTheFlood, `${engine.name} starved the timer phase`).toBe(true);
		expect(refused.length, `${engine.name} never reached the wait limit`).toBeGreaterThan(0);
		for (const outcome of refused) {
			expect(outcome.reason).toMatchObject({ code: "rate_limited" });
		}
	}, 120_000);

	it("refuses an existing and a missing identifier in exactly the same way", async () => {
		const harness = await createHarness(1, 100);

		const held = checkPassword({ userId: USER_ID, plaintext: PASSWORD }, harness.environment);
		const existing = checkPassword(
			{ userId: USER_ID, plaintext: PASSWORD },
			harness.environment,
		).catch((failure: unknown) => failure);
		const missing = checkPassword({ userId: null, plaintext: PASSWORD }, harness.environment).catch(
			(failure: unknown) => failure,
		);

		const [forExisting, forMissing] = await Promise.all([existing, missing]);

		expect(forExisting).toBeInstanceOf(Error);
		expect((forExisting as Error).constructor).toBe((forMissing as Error).constructor);
		expect({ ...(forExisting as object) }).toEqual({ ...(forMissing as object) });
		expect((forExisting as Error).message).toBe((forMissing as Error).message);

		harness.release();
		await held;
	}, 120_000);

	it("holds the concurrency ceiling under two hundred simultaneous sign-ins", async () => {
		const harness = await createHarness(4, 5000);

		const settled = Promise.allSettled(
			Array.from({ length: 200 }, () =>
				checkPassword({ userId: USER_ID, plaintext: PASSWORD }, harness.environment),
			),
		);

		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(harness.semaphore.peakInFlight).toBe(4);
		expect(harness.derivations()).toBe(4);

		harness.release();
		await settled;

		expect(harness.semaphore.peakInFlight).toBe(4);
		expect(harness.semaphore.inFlight).toBe(0);
		expect(harness.semaphore.waiting).toBe(0);
	}, 120_000);

	// S-DOS-6: the rehash takes a place from the same pool, so a rehash wave cannot displace a
	// sign-in. The check and the rehash are two calls on the same semaphore instance.
	it("charges the background rehash to the same semaphore as the check", async () => {
		const keys = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });
		const config = resolvePasswordConfig({ argon2id: CHEAP_ARGON2ID });
		const sealed = await sealPhc(keys, stored.byScheme.bcrypt);
		const rows = new Map<string, PasswordCredentialRow>([
			[USER_ID, { userId: USER_ID, phc: sealed.ciphertext, keyVersion: 1, scheme: "bcrypt" }],
		]);

		const driver: Driver = {
			async query<T>(sql: string, parameters: unknown[]): Promise<T[]> {
				if (sql.includes("SELECT")) {
					const row = rows.get(String(parameters[0]));
					return row === undefined
						? []
						: ([
								{
									user_id: row.userId,
									phc: row.phc,
									key_version: row.keyVersion,
									scheme: row.scheme,
								},
							] as T[]);
				}
				return [{ user_id: parameters[0] }] as T[];
			},
			transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T> {
				return fn(driver);
			},
		};

		const inner = createKdfSemaphore({ limit: 4 });
		let runs = 0;
		const semaphore: KdfSemaphore = {
			run(work) {
				runs += 1;
				return inner.run(work);
			},
			get inFlight() {
				return inner.inFlight;
			},
			get peakInFlight() {
				return inner.peakInFlight;
			},
			get waiting() {
				return inner.waiting;
			},
		};

		const environment: PasswordEnvironment = {
			config,
			keys,
			credentials: createPasswordCredentialRepository({ driver, keys }),
			semaphore,
			dummy: await createDummyCredential(keys, config),
		};

		const check = await checkPassword({ userId: USER_ID, plaintext: PASSWORD }, environment);
		expect(runs).toBe(1);

		if (check.outcome !== "verified" || check.rehash === undefined) {
			throw new Error("a bcrypt credential must ask to be rehashed");
		}

		await check.rehash();
		expect(runs).toBe(2);
		expect(inner.peakInFlight).toBeLessThanOrEqual(4);
	}, 120_000);
});

describe("S-DOS-3 — where the concurrency ceiling comes from", () => {
	const reported = Object.getOwnPropertyDescriptor(globalThis, "navigator");

	afterEach(() => {
		if (reported === undefined) {
			Reflect.deleteProperty(globalThis, "navigator");
		} else {
			Object.defineProperty(globalThis, "navigator", reported);
		}
	});

	it("follows the reported core count when the runtime reports one", () => {
		for (const hardwareConcurrency of [1, 2, 3, 4, 8, 64]) {
			Object.defineProperty(globalThis, "navigator", {
				configurable: true,
				value: { hardwareConcurrency },
			});

			expect(resolvePasswordConfig().concurrentHashLimit, `${hardwareConcurrency} cores`).toBe(
				Math.min(4, hardwareConcurrency),
			);
		}
	});

	// S-DOS-3 sizes the semaphore at `min(4, cpus)`, so a runtime that reports no core count may
	// not be answered with the ceiling: on a one-core Node 20 container that is four derivations
	// and about 76 MiB where the requirement allows one and 19 MiB (E-183, superseding E-162).
	it("falls back to one, not to the ceiling, when the runtime reports none", () => {
		Reflect.deleteProperty(globalThis, "navigator");

		expect(resolvePasswordConfig().concurrentHashLimit).toBe(1);
	});

	it("takes an explicit limit over both", () => {
		Reflect.deleteProperty(globalThis, "navigator");

		expect(resolvePasswordConfig({ concurrentHashLimit: 1 }).concurrentHashLimit).toBe(1);
	});
});
