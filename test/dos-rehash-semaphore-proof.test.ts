import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { KdfSemaphore } from "../src/core/password/semaphore.js";
import { actorOfTestUser } from "./db-fixtures.js";

/**
 * T-DOS-6 over the mounted route. Fifty accounts hold a bcrypt hash, so each sign-in verifies with
 * bcrypt and then rehashes to Argon2id after its answer. Every bcrypt and Argon2 call is counted
 * beneath the library, and the peak of those running at once is what the case decides on.
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
	const wrap = (derive: Derive) =>
		accounted<Parameters<Derive>, Awaited<ReturnType<Derive>>>(derive, memoryOf);
	return {
		...original,
		argon2idAsync: wrap(original.argon2idAsync),
		argon2iAsync: wrap(original.argon2iAsync),
		argon2dAsync: wrap(original.argon2dAsync),
	};
});

//the accelerator derives synchronously so only the pure engine lets two derivations overlap at all
vi.mock("hash-wasm", () => {
	throw new Error("the accelerator is out of the way for this measurement");
});

vi.mock("bcryptjs", async (importOriginal) => {
	const original = await importOriginal<typeof import("bcryptjs")>();
	const { accounted } = await import("./kdf-accounting-fixtures.js");
	const BCRYPT_STATE_KIB = 4;
	return {
		...original,
		compare: accounted<[string, string], boolean>(
			(plaintext, stored) => original.compare(plaintext, stored),
			() => BCRYPT_STATE_KIB,
		),
	};
});

const { toWebHandler } = await import("../src/core/http/web-handler.js");
const { rootKeyProvider } = await import("../src/core/keys/index.js");
const { createPasswordCredentialRepository } = await import("../src/core/password/credential.js");
const { createVelveAuth } = await import("../src/index.js");
const { configFor, createLogSink } = await import("./auth-fixtures.js");
const { openConnectionPool } = await import("./connection-pool-fixtures.js");
const { dropSchema, openMigratedSchema } = await import("./db-fixtures.js");
const { postTo } = await import("./flows-fixtures.js");
const { kdfAccounting } = await import("./kdf-accounting-fixtures.js");
const { generateRootKey } = await import("./keys-fixtures.js");
const { drawTestPassword } = await import("./password-fixtures.js");
const { hash: bcryptHash } = await import("bcryptjs");

type Migrated = Awaited<ReturnType<typeof openMigratedSchema>>;
type Pool = Awaited<ReturnType<typeof openConnectionPool>>;

const SIGN_INS = 50;
const BCRYPT_COST = 4;
const POOL_SIZE = 12;
const SETTLE_LIMIT_MS = 60_000;
const PASSWORD = drawTestPassword();
const keys = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });
const ceiling = Math.min(4, globalThis.navigator?.hardwareConcurrency ?? 1);

let migrated: Migrated;
let pool: Pool;
let handler: (request: Request) => Promise<Response>;
let semaphore: KdfSemaphore;
const log = createLogSink();
const accounts: { email: string; userId: string }[] = [];

beforeAll(async () => {
	migrated = await openMigratedSchema("dosrehash");
	pool = await openConnectionPool(POOL_SIZE);
	captured.semaphores.length = 0;
	handler = toWebHandler(
		createVelveAuth(
			configFor({
				database: pool,
				schema: migrated.schema,
				keys,
				log: log.write,
				rateLimit: {
					perIpAddress: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
					perAccount: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
				},
			}),
		),
	);
	semaphore = captured.semaphores[0] as KdfSemaphore;

	const bcrypt = await bcryptHash(PASSWORD, BCRYPT_COST);
	const credentials = createPasswordCredentialRepository({
		driver: migrated.connection,
		keys,
		schema: migrated.schema,
	});
	for (let index = 0; index < SIGN_INS; index += 1) {
		const email = `rehashwave${index}@example.com`;
		const [row] = await migrated.connection.query<{ id: string }>(
			`INSERT INTO ${migrated.schema}.user (email) VALUES ($1) RETURNING id`,
			[email],
		);
		const userId = (row as { id: string }).id;
		await credentials.write({
			actor: actorOfTestUser(userId),
			phc: bcrypt,
			scheme: "bcrypt",
			setBySessionId: null,
		});
		accounts.push({ email, userId });
	}
}, 120_000);

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
	await pool.close();
});

async function bcryptCredentialsLeft(): Promise<number> {
	const [row] = await migrated.connection.query<{ left: number }>(
		`SELECT count(*)::int AS left FROM ${migrated.schema}.password_credential WHERE scheme = 'bcrypt'`,
		[],
	);
	return (row as { left: number }).left;
}

function refusedRehashes(): number {
	return log.lines.filter((line) => line.message === "deferred work failed").length;
}

//a rehash the wait limit refuses is logged and stays for the next sign-in (E-11)
async function untilEveryRehashSettled(): Promise<number> {
	const deadline = Date.now() + SETTLE_LIMIT_MS;
	for (;;) {
		const landed = SIGN_INS - (await bcryptCredentialsLeft());
		if (landed + refusedRehashes() === SIGN_INS) {
			return landed;
		}
		if (Date.now() > deadline) {
			throw new Error(`${landed} rehashes landed and ${refusedRehashes()} were refused`);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("T-DOS-6 — the background rehash takes its place from the same semaphore (S-DOS-6)", () => {
	it("keeps verifications and rehashes of fifty sign-ins together within min(4, cpus)", async () => {
		while (kdfAccounting.inFlight > 0) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		kdfAccounting.reset();

		const answers = await Promise.all(
			accounts.map((account) =>
				handler(postTo("/sign-in/password", { email: account.email, password: PASSWORD })),
			),
		);
		const landed = await untilEveryRehashSettled();

		expect(answers.map((answer) => answer.status).filter((status) => status !== 200)).toStrictEqual(
			[],
		);
		expect(landed, "rehashes that took effect").toBeGreaterThan(ceiling);
		expect(kdfAccounting.calls, "fifty verifications and the rehashes that ran").toBe(
			SIGN_INS + landed,
		);
		expect(kdfAccounting.peakInFlight, "bcrypt and Argon2 running at once").toBeLessThanOrEqual(
			ceiling,
		);
		expect(semaphore.peakInFlight).toBe(ceiling);
		expect(semaphore.inFlight).toBe(0);
	}, 120_000);
});
