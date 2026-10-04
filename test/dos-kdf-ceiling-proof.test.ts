import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { KdfSemaphore } from "../src/core/password/semaphore.js";

/**
 * T-DOS-3 over the mounted route with real derivations. The ceiling is read twice: from the one
 * semaphore the assembly builds, and from a count kept beneath the library around every Argon2
 * call of either engine, which is also where the memory each derivation asks for is summed.
 */

const captured = vi.hoisted(() => ({ semaphores: [] as KdfSemaphore[] }));

vi.mock("../src/core/password/semaphore.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/core/password/semaphore.js")>();
	return {
		...original,
		createKdfSemaphore: (options: Parameters<typeof original.createKdfSemaphore>[0]) => {
			const semaphore = original.createKdfSemaphore(options);
			captured.semaphores.push(semaphore);
			return semaphore;
		},
	};
});

vi.mock("@noble/hashes/argon2.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("@noble/hashes/argon2.js")>();
	const { accounted } = await import("./kdf-accounting-fixtures.js");
	type Derive = typeof original.argon2idAsync;
	const memoryOf = (...args: Parameters<Derive>) => Number(args[2]?.m ?? 0);
	return {
		...original,
		argon2idAsync: accounted<Parameters<Derive>, Awaited<ReturnType<Derive>>>(
			original.argon2idAsync,
			memoryOf,
		),
		argon2iAsync: accounted<Parameters<Derive>, Awaited<ReturnType<Derive>>>(
			original.argon2iAsync,
			memoryOf,
		),
		argon2dAsync: accounted<Parameters<Derive>, Awaited<ReturnType<Derive>>>(
			original.argon2dAsync,
			memoryOf,
		),
	};
});

vi.mock("hash-wasm", async (importOriginal) => {
	const original = await importOriginal<typeof import("hash-wasm")>();
	const { accounted } = await import("./kdf-accounting-fixtures.js");
	type Options = Parameters<typeof original.argon2id>[0];
	const wrap = (derive: (options: Options) => Promise<unknown>) =>
		accounted<[Options], unknown>(derive, (options) => options.memorySize);
	return {
		argon2id: wrap(original.argon2id),
		argon2i: wrap(original.argon2i),
		argon2d: wrap(original.argon2d),
	};
});

const { argon2idAsync } = await import("@noble/hashes/argon2.js");
const { toWebHandler } = await import("../src/core/http/web-handler.js");
const { rootKeyProvider } = await import("../src/core/keys/index.js");
const { createArgon2idHash } = await import("../src/core/password/argon2.js");
const { encodeStandardBase64 } = await import("../src/core/password/base64.js");
const { createPasswordCredentialRepository } = await import("../src/core/password/credential.js");
const { MAXIMUM_STORED_MEMORY_KIB } = await import("../src/core/password/limits.js");
const { createVelveAuth } = await import("../src/index.js");
const { configFor } = await import("./auth-fixtures.js");
const { openConnectionPool } = await import("./connection-pool-fixtures.js");
const { dropSchema, openMigratedSchema } = await import("./db-fixtures.js");
const { postTo } = await import("./flows-fixtures.js");
const { kdfAccounting } = await import("./kdf-accounting-fixtures.js");
const { generateRootKey } = await import("./keys-fixtures.js");
const { drawTestPassword } = await import("./password-fixtures.js");

type Migrated = Awaited<ReturnType<typeof openMigratedSchema>>;
type Pool = Awaited<ReturnType<typeof openConnectionPool>>;

const NIGHTLY = process.env.VELVE_NIGHTLY === "1";
const SIMULTANEOUS_SIGN_INS = 200;
const ACCOUNTS = 20;
const POOL_SIZE = 12;
const CONFIGURED_MEMORY_KIB = 19456;
const RSS_TOLERANCE = 1.5;
const KIB = 1024;

const PASSWORD = drawTestPassword();
const keys = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });
const ceiling = Math.min(4, globalThis.navigator?.hardwareConcurrency ?? 1);

let migrated: Migrated;
let pool: Pool;
let handler: (request: Request) => Promise<Response>;
let semaphore: KdfSemaphore;
const atConfiguredParameters: string[] = [];
const importedAtTheCap: string[] = [];

async function seedAccounts(prefix: string, phc: string): Promise<string[]> {
	const credentials = createPasswordCredentialRepository({
		driver: migrated.connection,
		keys,
		schema: migrated.schema,
	});
	const emails: string[] = [];
	for (let index = 0; index < ACCOUNTS; index += 1) {
		const email = `${prefix}${index}@ceiling.example`;
		const [row] = await migrated.connection.query<{ id: string }>(
			`INSERT INTO ${migrated.schema}.user (email) VALUES ($1) RETURNING id`,
			[email],
		);
		await credentials.write({
			userId: (row as { id: string }).id,
			phc,
			scheme: "argon2id",
			setBySessionId: null,
		});
		emails.push(email);
	}
	return emails;
}

//a credential an import brought in at the highest memory cost verification still accepts
async function phcAtTheImportCap(): Promise<string> {
	const salt = new Uint8Array(16).fill(7);
	const hash = await argon2idAsync(new TextEncoder().encode(PASSWORD), salt, {
		m: MAXIMUM_STORED_MEMORY_KIB,
		t: 1,
		p: 1,
		dkLen: 32,
		version: 0x13,
	});
	return `$argon2id$v=19$m=${MAXIMUM_STORED_MEMORY_KIB},t=1,p=1$${encodeStandardBase64(salt)}$${encodeStandardBase64(hash)}`;
}

beforeAll(async () => {
	migrated = await openMigratedSchema("dosceiling");
	pool = await openConnectionPool(POOL_SIZE);
	captured.semaphores.length = 0;
	const auth = createVelveAuth(
		configFor({
			database: pool,
			schema: migrated.schema,
			keys,
			rateLimit: {
				perIpAddress: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
				perAccount: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
			},
		}),
	);
	handler = toWebHandler(auth);
	const [only] = captured.semaphores;
	if (only === undefined || captured.semaphores.length !== 1) {
		throw new Error(`the assembly built ${captured.semaphores.length} semaphores`);
	}
	semaphore = only;

	const configured = await createArgon2idHash(new TextEncoder().encode(PASSWORD), {
		memoryKiB: CONFIGURED_MEMORY_KIB,
		iterations: 2,
		parallelism: 1,
	});
	atConfiguredParameters.push(...(await seedAccounts("configured", configured)));
	importedAtTheCap.push(...(await seedAccounts("imported", await phcAtTheImportCap())));
}, 120_000);

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
	await pool.close();
});

async function signInWave(emails: readonly string[], count: number): Promise<number[]> {
	await handler(postTo("/sign-in/password", { email: emails[0], password: PASSWORD }));
	kdfAccounting.reset();
	const answers = await Promise.all(
		Array.from({ length: count }, (_, index) =>
			handler(
				postTo("/sign-in/password", { email: emails[index % emails.length], password: PASSWORD }),
			),
		),
	);
	return answers.map((answer) => answer.status);
}

describe("T-DOS-3 — the semaphore bounds the derivations running at once (S-DOS-3)", () => {
	it("holds two hundred simultaneous sign-ins at the default parameters to min(4, cpus)", async () => {
		const statuses = await signInWave(atConfiguredParameters, SIMULTANEOUS_SIGN_INS);

		expect(statuses.filter((status) => status !== 200 && status !== 429)).toStrictEqual([]);
		expect(statuses.filter((status) => status === 200).length).toBeGreaterThan(ceiling);
		expect(kdfAccounting.calls).toBeGreaterThanOrEqual(SIMULTANEOUS_SIGN_INS / 2);
		expect(semaphore.peakInFlight, "the semaphore's own count, under contention").toBe(ceiling);
		expect(kdfAccounting.peakInFlight, "derivations running beneath it").toBeLessThanOrEqual(
			ceiling,
		);
		expect(kdfAccounting.peakInFlightKiB).toBeLessThanOrEqual(ceiling * CONFIGURED_MEMORY_KIB);
		expect(semaphore.inFlight).toBe(0);
	}, 120_000);

	//every accelerator call leaves its own wasm memory for the collector so the resident set outgrows the bound (S-DOS-3)
	(NIGHTLY ? it.fails : it.skip)(
		"grows the resident set by less than min(4, cpus) times 19 MiB times 1.5",
		async () => {
			let peakRss = process.memoryUsage().rss;
			const baselineRss = peakRss;
			const sampler = setInterval(() => {
				peakRss = Math.max(peakRss, process.memoryUsage().rss);
			}, 5);
			try {
				await signInWave(atConfiguredParameters, SIMULTANEOUS_SIGN_INS);
			} finally {
				clearInterval(sampler);
			}

			const growthMiB = (peakRss - baselineRss) / KIB / KIB;
			expect(growthMiB).toBeLessThan(((ceiling * CONFIGURED_MEMORY_KIB) / KIB) * RSS_TOLERANCE);
		},
		120_000,
	);

	//an imported credential may ask for 64 MiB per derivation which the bound assumes is 19 MiB (S-DOS-3)
	it.fails("keeps derivation memory within the semaphore size times the configured parameter for imported credentials", async () => {
		await signInWave(importedAtTheCap, 4 * ceiling);

		expect(Math.max(...kdfAccounting.memoryRequestsKiB)).toBeLessThanOrEqual(CONFIGURED_MEMORY_KIB);
		expect(kdfAccounting.peakInFlightKiB).toBeLessThanOrEqual(ceiling * CONFIGURED_MEMORY_KIB);
	}, 120_000);
});
