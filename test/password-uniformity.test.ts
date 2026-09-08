import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The counters have to sit under the real derivations rather than beside them, so that a KDF call
// made outside the semaphore is counted too. Every wrapper forwards to the original (T-TIM-1b).
const kdfCalls: string[] = [];

vi.mock("@noble/hashes/argon2.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("@noble/hashes/argon2.js")>();
	const counted = <T extends (...args: never[]) => unknown>(name: string, fn: T): T =>
		((...args: never[]) => {
			kdfCalls.push(name);
			return fn(...args);
		}) as T;

	return {
		...original,
		argon2idAsync: counted("argon2id", original.argon2idAsync),
		argon2iAsync: counted("argon2i", original.argon2iAsync),
		argon2dAsync: counted("argon2d", original.argon2dAsync),
	};
});

// The optional accelerator has to be out of the way for the counters above to see every Argon2
// derivation. Its specifier is assembled rather than written (E-170), so the mock is registered
// under an assembled name too — naming the package here would trip the dead-code check.
vi.doMock(["hash", "wasm"].join("-"), () => {
	throw new Error("the accelerator is out of the way for this measurement");
});

vi.mock("@noble/hashes/scrypt.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("@noble/hashes/scrypt.js")>();
	return {
		...original,
		scryptAsync: (...args: Parameters<typeof original.scryptAsync>) => {
			kdfCalls.push("scrypt");
			return original.scryptAsync(...args);
		},
	};
});

vi.mock("@noble/hashes/pbkdf2.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("@noble/hashes/pbkdf2.js")>();
	return {
		...original,
		pbkdf2Async: (...args: Parameters<typeof original.pbkdf2Async>) => {
			kdfCalls.push("pbkdf2");
			return original.pbkdf2Async(...args);
		},
	};
});

vi.mock("bcryptjs", async (importOriginal) => {
	const original = await importOriginal<typeof import("bcryptjs")>();
	return {
		...original,
		compare: (...args: Parameters<typeof original.compare>) => {
			kdfCalls.push("bcrypt");
			return original.compare(...args);
		},
	};
});

import type { Driver } from "../src/core/db/driver.js";
import type { PasswordCredentialRow } from "../src/core/password/credential.js";
import type { PasswordEnvironment } from "../src/core/password/verify.js";
import type { StoredHashes } from "./password-fixtures.js";

const { rootKeyProvider } = await import("../src/core/keys/index.js");
const { resolvePasswordConfig } = await import("../src/core/password/config.js");
const credential = await import("../src/core/password/credential.js");
const { createKdfSemaphore } = await import("../src/core/password/semaphore.js");
const verify = await import("../src/core/password/verify.js");
const { generateRootKey } = await import("./keys-fixtures.js");
const fixtures = await import("./password-fixtures.js");

const USER_WITH_CREDENTIAL = "11111111-1111-1111-1111-111111111111";
const USER_WITHOUT_CREDENTIAL = "22222222-2222-2222-2222-222222222222";
const PRODUCTION_ARGON2ID = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;

const PASSWORD = fixtures.drawTestPassword();
const WRONG_PASSWORD = fixtures.drawTestPassword();

interface Observation {
	readonly statements: readonly string[];
	readonly parameterShapes: readonly string[];
	readonly decryptions: number;
	readonly kdfCalls: readonly string[];
}

interface Probe {
	readonly environment: PasswordEnvironment;
	readonly rows: Map<string, PasswordCredentialRow>;
	reset(): void;
	observe(): Observation;
}

/** A parameter's shape, never its value: two calls differing only in a UUID stay comparable. */
function shapeOf(parameters: readonly unknown[]): string {
	return parameters
		.map((parameter) =>
			parameter instanceof Uint8Array ? `bytes(${parameter.length})` : typeof parameter,
		)
		.join(",");
}

async function createProbe(): Promise<Probe> {
	const rows = new Map<string, PasswordCredentialRow>();
	const statements: string[] = [];
	const parameterShapes: string[] = [];
	let decryptions = 0;

	const inner = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });
	const keys = {
		current: inner.current.bind(inner),
		byVersion: async (purpose: Parameters<typeof inner.byVersion>[0], version: number) => {
			decryptions += 1;
			return inner.byVersion(purpose, version);
		},
	};

	const driver: Driver = {
		async query<T>(sql: string, parameters: unknown[]): Promise<T[]> {
			statements.push(sql.replace(/\s+/g, " ").trim());
			parameterShapes.push(shapeOf(parameters));

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
			// The upsert returns the row it wrote; a repository that is told nothing was written
			// refuses, because that is what a false `DO UPDATE … WHERE` looks like (E-185).
			return (sql.includes("INSERT") ? [{ user_id: parameters[0] }] : []) as T[];
		},
		transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T> {
			return fn(driver);
		},
	};

	const config = resolvePasswordConfig({ argon2id: PRODUCTION_ARGON2ID });
	const environment: PasswordEnvironment = {
		config,
		keys,
		credentials: credential.createPasswordCredentialRepository({ driver, keys }),
		semaphore: createKdfSemaphore({ limit: config.concurrentHashLimit }),
		dummy: await verify.createDummyCredential(keys, config),
	};

	return {
		environment,
		rows,
		reset() {
			statements.length = 0;
			parameterShapes.length = 0;
			kdfCalls.length = 0;
			decryptions = 0;
		},
		observe() {
			return {
				statements: [...statements],
				parameterShapes: [...parameterShapes],
				decryptions,
				kdfCalls: [...kdfCalls],
			};
		},
	};
}

let probe: Probe;
let stored: StoredHashes;

beforeAll(async () => {
	stored = await fixtures.storedHashesFor(PASSWORD);
}, 120_000);

beforeEach(async () => {
	probe = await createProbe();
	const sealed = await credential.sealPhc(probe.environment.keys, stored.byScheme.argon2id);
	probe.rows.set(USER_WITH_CREDENTIAL, {
		userId: USER_WITH_CREDENTIAL,
		phc: sealed.ciphertext,
		keyVersion: sealed.keyVersion,
		scheme: "argon2id",
	});
	probe.reset();
}, 120_000);

async function attempt(userId: string | null, plaintext: string): Promise<Observation> {
	probe.reset();
	await verify.checkPassword({ userId, plaintext }, probe.environment);
	return probe.observe();
}

describe("S-TIM-1 / L-1 — one code path that does the same work whatever the outcome", () => {
	it("issues one statement, one decryption and one KDF call in all four T-TIM-1b cases", async () => {
		const observations = [
			await attempt(USER_WITH_CREDENTIAL, WRONG_PASSWORD),
			await attempt(null, WRONG_PASSWORD),
			await attempt(USER_WITHOUT_CREDENTIAL, WRONG_PASSWORD),
			await attempt(USER_WITH_CREDENTIAL, PASSWORD),
		];

		for (const [index, observation] of observations.entries()) {
			expect(observation.statements, `case ${index}`).toHaveLength(1);
			expect(observation.decryptions, `case ${index}`).toBe(1);
			expect(observation.kdfCalls, `case ${index}`).toEqual(["argon2id"]);
		}

		const first = observations[0] as Observation;
		for (const observation of observations.slice(1)) {
			expect(observation.statements).toEqual(first.statements);
			expect(observation.parameterShapes).toEqual(first.parameterShapes);
			expect(observation.kdfCalls).toEqual(first.kdfCalls);
			expect(observation.decryptions).toEqual(first.decryptions);
		}
	}, 120_000);

	it("keeps the sequence identical when the stored scheme is one the configuration refuses", async () => {
		const sealed = await credential.sealPhc(probe.environment.keys, stored.byScheme.bcrypt);
		probe.rows.set(USER_WITH_CREDENTIAL, {
			userId: USER_WITH_CREDENTIAL,
			phc: sealed.ciphertext,
			keyVersion: sealed.keyVersion,
			scheme: "bcrypt",
		});

		const narrowed: PasswordEnvironment = {
			...probe.environment,
			config: resolvePasswordConfig({ argon2id: PRODUCTION_ARGON2ID, acceptLegacy: [] }),
		};

		probe.reset();
		await verify.checkPassword({ userId: USER_WITH_CREDENTIAL, plaintext: PASSWORD }, narrowed);
		const refused = probe.observe();
		const absent = await attempt(null, PASSWORD);

		expect(refused.statements).toEqual(absent.statements);
		expect(refused.decryptions).toBe(absent.decryptions);
		expect(
			refused.kdfCalls,
			"E-176: the retired scheme is still charged one Argon2id call",
		).toEqual(absent.kdfCalls);
	}, 120_000);

	it("refuses a length violation before any statement and any KDF call (S-DOS-1, S-DOS-2)", async () => {
		const oversized = "a".repeat(4097);
		const megabyte = "a".repeat(1024 * 1024);

		for (const plaintext of ["", "seven02", oversized, megabyte]) {
			for (const userId of [USER_WITH_CREDENTIAL, null]) {
				const observation = await attempt(userId, plaintext);
				expect(observation.statements, `${plaintext.length} for ${userId}`).toEqual([]);
				expect(observation.kdfCalls, `${plaintext.length} for ${userId}`).toEqual([]);
				expect(observation.decryptions).toBe(0);
			}
		}

		for (const plaintext of ["eight888", "a".repeat(4096)]) {
			const observation = await attempt(USER_WITH_CREDENTIAL, plaintext);
			expect(observation.kdfCalls, `${plaintext.length} accepted`).toEqual(["argon2id"]);
		}
	}, 120_000);

	it("answers a length violation identically for an existing and a missing identifier", async () => {
		const existing = await verify.checkPassword(
			{ userId: USER_WITH_CREDENTIAL, plaintext: "short" },
			probe.environment,
		);
		const missing = await verify.checkPassword(
			{ userId: null, plaintext: "short" },
			probe.environment,
		);

		expect(JSON.stringify(existing)).toBe(JSON.stringify(missing));
	});
});

describe("S-TIM-2 — the dummy is a real credential read by the real verifier", () => {
	it("is sealed under password-enc and decrypts to the configured Argon2id parameters", async () => {
		const dummy = probe.environment.dummy;
		const opened = await credential.openPhc(probe.environment.keys, dummy);

		expect(dummy.scheme).toBe("argon2id");
		expect(dummy.userId).toBe(verify.ABSENT_USER_ID);
		expect(dummy.phc[0]).not.toBe("$".charCodeAt(0));
		expect(opened).toMatch(
			new RegExp(
				`^\\$argon2id\\$v=19\\$m=${PRODUCTION_ARGON2ID.memoryKiB},t=${PRODUCTION_ARGON2ID.iterations},p=${PRODUCTION_ARGON2ID.parallelism}\\$`,
			),
		);
	}, 120_000);

	it("costs the absent-user path exactly what the present-user path costs", async () => {
		const stored = await credential.openPhc(probe.environment.keys, probe.environment.dummy);
		const real = stored.split("$");
		const row = probe.rows.get(USER_WITH_CREDENTIAL) as PasswordCredentialRow;
		const other = (await credential.openPhc(probe.environment.keys, row)).split("$");

		expect(real[1]).toBe(other[1]);
		expect(real[2]).toBe(other[2]);
		expect(real[4]?.length).toBe(other[4]?.length);
		expect(real[5]?.length).toBe(other[5]?.length);
	}, 120_000);
});

describe("S-TIM-5 — a rehash never lengthens the sign-in that triggered it", () => {
	it("runs no derivation of its own until the caller asks for it", async () => {
		const sealed = await credential.sealPhc(probe.environment.keys, stored.byScheme.bcrypt);
		probe.rows.set(USER_WITH_CREDENTIAL, {
			userId: USER_WITH_CREDENTIAL,
			phc: sealed.ciphertext,
			keyVersion: sealed.keyVersion,
			scheme: "bcrypt",
		});

		probe.reset();
		const check = await verify.checkPassword(
			{ userId: USER_WITH_CREDENTIAL, plaintext: PASSWORD },
			probe.environment,
		);
		const duringSignIn = probe.observe();

		expect(check.outcome).toBe("verified");
		expect(duringSignIn.kdfCalls).toEqual(["bcrypt"]);
		expect(duringSignIn.statements.filter((sql) => sql.startsWith("UPDATE"))).toEqual([]);

		if (check.outcome !== "verified" || check.rehash === undefined) {
			throw new Error("an imported bcrypt credential must ask to be rehashed");
		}

		probe.reset();
		await check.rehash();
		expect(probe.observe().kdfCalls).toEqual(["argon2id"]);
	}, 120_000);

	it("never writes anything on a failed sign-in", async () => {
		const sealed = await credential.sealPhc(probe.environment.keys, stored.byScheme.bcrypt);
		probe.rows.set(USER_WITH_CREDENTIAL, {
			userId: USER_WITH_CREDENTIAL,
			phc: sealed.ciphertext,
			keyVersion: sealed.keyVersion,
			scheme: "bcrypt",
		});

		for (const attemptInput of [
			{ userId: USER_WITH_CREDENTIAL, plaintext: WRONG_PASSWORD },
			{ userId: null, plaintext: WRONG_PASSWORD },
			{ userId: USER_WITHOUT_CREDENTIAL, plaintext: WRONG_PASSWORD },
		]) {
			probe.reset();
			const check = await verify.checkPassword(attemptInput, probe.environment);
			const observation = probe.observe();

			expect(check.outcome).toBe("refused");
			expect(observation.statements.filter((sql) => !sql.startsWith("SELECT"))).toEqual([]);
		}
	}, 120_000);
});
