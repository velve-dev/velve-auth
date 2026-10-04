import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { KdfSemaphore } from "../src/core/password/semaphore.js";
import { actorOfTestUser } from "./db-fixtures.js";

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
const WAVES_BEFORE_COLLECTING = 3;
const KIB = 1024;
const SETTLE_LIMIT_MS = 30_000;

const PASSWORD = drawTestPassword();
const keys = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });
const ceiling = Math.min(4, globalThis.navigator?.hardwareConcurrency ?? 1);
const boundPerPlaceKiB = Math.max(CONFIGURED_MEMORY_KIB, MAXIMUM_STORED_MEMORY_KIB);
const residentBoundMiB = ((ceiling * boundPerPlaceKiB) / KIB) * RSS_TOLERANCE;

let migrated: Migrated;
let pool: Pool;
let handler: (request: Request) => Promise<Response>;
let semaphore: KdfSemaphore;
const atConfiguredParameters: string[] = [];
const importedAtTheCap: string[] = [];
const importedAtTheCapNeverSignedIn: string[] = [];
const importedAtTheCapWithTheConfiguredCost: string[] = [];
const importedAboveTheCap: string[] = [];

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
			actor: actorOfTestUser((row as { id: string }).id),
			phc,
			scheme: "argon2id",
			setBySessionId: null,
		});
		emails.push(email);
	}
	return emails;
}

//a credential an import brought in at the highest memory cost verification still accepts
async function phcAtTheImportCap(iterations: number): Promise<string> {
	const salt = new Uint8Array(16).fill(7);
	const hash = await argon2idAsync(new TextEncoder().encode(PASSWORD), salt, {
		m: MAXIMUM_STORED_MEMORY_KIB,
		t: iterations,
		p: 1,
		dkLen: 32,
		version: 0x13,
	});
	return `$argon2id$v=19$m=${MAXIMUM_STORED_MEMORY_KIB},t=${iterations},p=1$${encodeStandardBase64(salt)}$${encodeStandardBase64(hash)}`;
}

//verification refuses this one before deriving so its hash bytes never matter
function phcAboveTheImportCap(): string {
	const filler = encodeStandardBase64(new Uint8Array(32).fill(9));
	return `$argon2id$v=19$m=${MAXIMUM_STORED_MEMORY_KIB + 1},t=2,p=1$${filler}$${filler}`;
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
	importedAtTheCap.push(...(await seedAccounts("imported", await phcAtTheImportCap(1))));
	importedAtTheCapNeverSignedIn.push(
		...(await seedAccounts("importedfirst", await phcAtTheImportCap(1))),
	);
	importedAtTheCapWithTheConfiguredCost.push(
		...(await seedAccounts("importedcost", await phcAtTheImportCap(2))),
	);
	importedAboveTheCap.push(...(await seedAccounts("abovecap", phcAboveTheImportCap())));
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

//a collection forced on both sides of a wave tells garbage not yet reclaimed from memory still held
function collectGarbage(): void {
	setFlagsFromString("--expose-gc");
	(runInNewContext("gc") as () => void)();
}

function residentMiB(): number {
	return process.memoryUsage().rss / KIB / KIB;
}

async function storedCiphertexts(emails: readonly string[]): Promise<string[]> {
	const rows = await migrated.connection.query<{ phc: string }>(
		`SELECT encode(credential.phc, 'hex') AS phc
		 FROM ${migrated.schema}.password_credential credential
		 JOIN ${migrated.schema}.user account ON account.id = credential.user_id
		 WHERE account.email = ANY(string_to_array($1, ' '))
		 ORDER BY account.email`,
		[emails.join(" ")],
	);
	return rows.map((row) => row.phc);
}

//the rehash runs after the answer so the test waits until every row has been rewritten
async function untilEveryCredentialRewritten(
	emails: readonly string[],
	before: readonly string[],
): Promise<void> {
	const deadline = Date.now() + SETTLE_LIMIT_MS;
	for (;;) {
		const after = await storedCiphertexts(emails);
		const unchanged = after.filter((ciphertext, index) => ciphertext === before[index]).length;
		if (unchanged === 0) {
			return;
		}
		if (Date.now() > deadline) {
			throw new Error(`${unchanged} of ${emails.length} credentials were never rewritten`);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("T-DOS-3 — the semaphore bounds the derivations running at once (S-DOS-3)", () => {
	it("holds two hundred simultaneous sign-ins at the default parameters to min(4, cpus)", async () => {
		const statuses = await signInWave(atConfiguredParameters, SIMULTANEOUS_SIGN_INS);

		expect(statuses.filter((status) => status !== 200 && status !== 429)).toStrictEqual([]);
		expect(statuses.filter((status) => status === 200).length).toBeGreaterThan(ceiling);
		expect(kdfAccounting.calls).toBeGreaterThan(ceiling);
		expect(semaphore.peakInFlight, "the semaphore's own count, under contention").toBe(ceiling);
		expect(kdfAccounting.peakInFlight, "derivations running beneath it").toBeLessThanOrEqual(
			ceiling,
		);
		expect(kdfAccounting.peakInFlightKiB).toBeLessThanOrEqual(ceiling * CONFIGURED_MEMORY_KIB);
		expect(semaphore.inFlight).toBe(0);
	}, 120_000);

	//the resident set holds garbage the collector has not yet reclaimed and returns once it has (E-2612)
	(NIGHTLY ? it.fails : it.skip)(
		"grows the resident set by less than min(4, cpus) times max(m, 64 MiB) times 1.5",
		async () => {
			collectGarbage();
			const baselineMiB = residentMiB();
			let peakMiB = baselineMiB;
			const sampler = setInterval(() => {
				peakMiB = Math.max(peakMiB, residentMiB());
			}, 5);
			try {
				await signInWave(atConfiguredParameters, SIMULTANEOUS_SIGN_INS);
			} finally {
				clearInterval(sampler);
			}

			expect(peakMiB - baselineMiB).toBeLessThan(residentBoundMiB);
		},
		120_000,
	);

	(NIGHTLY ? it : it.skip)(
		"returns the resident set within that bound once the collector has run, wave after wave",
		async () => {
			collectGarbage();
			const baselineMiB = residentMiB();
			const afterEachWaveMiB: number[] = [];
			for (let wave = 0; wave < WAVES_BEFORE_COLLECTING; wave += 1) {
				await signInWave(atConfiguredParameters, SIMULTANEOUS_SIGN_INS);
				collectGarbage();
				afterEachWaveMiB.push(residentMiB() - baselineMiB);
			}

			expect(Math.max(...afterEachWaveMiB)).toBeLessThan(residentBoundMiB);
		},
		300_000,
	);

	it("keeps an imported derivation within the import ceiling and the wave within min(4, cpus) times max(m, 64 MiB)", async () => {
		const statuses = await signInWave(importedAtTheCap, SIMULTANEOUS_SIGN_INS);

		expect(statuses.filter((status) => status !== 200 && status !== 429)).toStrictEqual([]);
		expect(statuses.filter((status) => status === 200).length).toBeGreaterThan(ceiling);
		expect(
			Math.max(...kdfAccounting.memoryRequestsKiB),
			"an import at the ceiling was derived",
		).toBe(MAXIMUM_STORED_MEMORY_KIB);
		expect(semaphore.peakInFlight).toBeLessThanOrEqual(ceiling);
		expect(kdfAccounting.peakInFlight).toBeLessThanOrEqual(ceiling);
		expect(kdfAccounting.peakInFlightKiB).toBeLessThanOrEqual(ceiling * boundPerPlaceKiB);
	}, 120_000);

	it("never derives a credential above the import ceiling", async () => {
		const statuses = await signInWave(importedAboveTheCap, 4 * ceiling);

		expect(statuses.filter((status) => status === 200)).toStrictEqual([]);
		expect(
			kdfAccounting.memoryRequestsKiB.filter((memoryKiB) => memoryKiB > MAXIMUM_STORED_MEMORY_KIB),
		).toStrictEqual([]);
	}, 120_000);

	it("moves an imported credential to the configured parameters at its first successful sign-in", async () => {
		const imported = [...importedAtTheCapNeverSignedIn, ...importedAtTheCapWithTheConfiguredCost];
		const before = await storedCiphertexts(imported);
		for (const email of imported) {
			const answer = await handler(postTo("/sign-in/password", { email, password: PASSWORD }));
			expect(answer.status).toBe(200);
		}
		await untilEveryCredentialRewritten(imported, before);

		kdfAccounting.reset();
		for (const email of imported) {
			const answer = await handler(postTo("/sign-in/password", { email, password: PASSWORD }));
			expect(answer.status).toBe(200);
		}
		expect(kdfAccounting.memoryRequestsKiB).toStrictEqual(
			imported.map(() => CONFIGURED_MEMORY_KIB),
		);
	}, 180_000);
});
