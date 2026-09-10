import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { rootKeyProvider } from "../src/core/keys/index.js";
import { ARGON2ID_FLOOR, resolvePasswordConfig } from "../src/core/password/config.js";
import {
	createPasswordCredentialRepository,
	openPhc,
	type PasswordCredentialRepositoryOptions,
	type PasswordCredentialRow,
	type SealedPhc,
	sealPhc,
} from "../src/core/password/credential.js";
import type { CredentialWriteErrorCode } from "../src/core/password/errors.js";
import { parsePhc } from "../src/core/password/phc.js";
import { needsRehash } from "../src/core/password/rehash.js";
import type { PasswordScheme } from "../src/core/password/scheme.js";
import { createKdfSemaphore } from "../src/core/password/semaphore.js";
import {
	assertStoredKeyVersionsAreKnown,
	PasswordKeyRingError,
	type StoredKeyVersionCheckOptions,
} from "../src/core/password/startup.js";
import {
	ABSENT_USER_ID,
	checkPassword,
	createDummyCredential,
	type PasswordCheck,
	type PasswordEnvironment,
	setPassword,
} from "../src/core/password/verify.js";
import { generateRootKey } from "./keys-fixtures.js";
import { drawTestPassword, type StoredHashes, storedHashesFor } from "./password-fixtures.js";

const USER_ID = "11111111-2222-3333-4444-555555555555";
const PASSWORD = drawTestPassword();
const WRONG_PASSWORD = drawTestPassword();

const CHEAP_ARGON2ID = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const NOT_WRITTEN: CredentialWriteErrorCode = "credential_not_written";

interface Call {
	readonly sql: string;
	readonly params: readonly unknown[];
}

interface Recorder {
	readonly calls: Call[];
	readonly driver: Driver;
	rows: Map<string, PasswordCredentialRow>;
}

function recordingDriver(): Recorder {
	const rows = new Map<string, PasswordCredentialRow>();
	const calls: Call[] = [];

	const driver: Driver = {
		async query<T>(sql: string, params: unknown[]): Promise<T[]> {
			calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params: [...params] });

			if (sql.includes("SELECT DISTINCT key_version")) {
				return [...new Set([...rows.values()].map((row) => row.keyVersion))]
					.sort((left, right) => left - right)
					.map((keyVersion) => ({ key_version: keyVersion })) as T[];
			}

			if (sql.includes("SELECT")) {
				const row = rows.get(String(params[0]));
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

			if (sql.includes("INSERT")) {
				rows.set(String(params[0]), {
					userId: String(params[0]),
					phc: params[1] as Uint8Array<ArrayBuffer>,
					keyVersion: params[2] as number,
					scheme: params[3] as PasswordScheme,
				});
				// The upsert returns the row it wrote; answering nothing is what a false
				// `DO UPDATE … WHERE` looks like, and the repository refuses that (E-185).
				return [{ user_id: params[0] }] as T[];
			}

			const existing = rows.get(String(params[0]));
			const previous = params[4] as Uint8Array<ArrayBuffer>;
			if (existing === undefined || !sameBytes(existing.phc, previous)) {
				return [];
			}
			rows.set(String(params[0]), {
				userId: String(params[0]),
				phc: params[1] as Uint8Array<ArrayBuffer>,
				keyVersion: params[3] as number,
				scheme: params[2] as PasswordScheme,
			});
			return [{ user_id: params[0] }] as T[];
		},

		transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T> {
			return fn(driver);
		},
	};

	return { calls, driver, rows };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

async function environmentWith(recorder: Recorder): Promise<PasswordEnvironment> {
	const keys = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });
	const config = resolvePasswordConfig({ argon2id: CHEAP_ARGON2ID });
	const options: PasswordCredentialRepositoryOptions = { driver: recorder.driver, keys };
	const credentials = createPasswordCredentialRepository(options);

	return {
		config,
		keys,
		credentials,
		semaphore: createKdfSemaphore({ limit: config.concurrentHashLimit }),
		dummy: await createDummyCredential(keys, config),
	};
}

let environment: PasswordEnvironment;
let recorder: Recorder;
let stored: StoredHashes;

beforeAll(async () => {
	stored = await storedHashesFor(PASSWORD);
}, 60_000);

beforeEach(async () => {
	recorder = recordingDriver();
	environment = await environmentWith(recorder);
	recorder.calls.length = 0;
}, 60_000);

async function seed(phc: string, scheme: PasswordScheme, userId = USER_ID): Promise<void> {
	const sealed: SealedPhc = await sealPhc(environment.keys, phc);
	recorder.rows.set(userId, {
		userId,
		phc: sealed.ciphertext,
		keyVersion: sealed.keyVersion,
		scheme,
	});
}

function callShapes(): string[] {
	return recorder.calls.map((call) => call.sql);
}

describe("the stored credential", () => {
	it("writes the PHC string encrypted and the scheme in the clear", async () => {
		await setPassword({ userId: USER_ID, plaintext: PASSWORD, setBySessionId: null }, environment);
		const row = recorder.rows.get(USER_ID);

		expect(row?.scheme).toBe("argon2id");
		expect(row?.keyVersion).toBe(1);
		expect(new TextDecoder().decode(row?.phc)).not.toContain("$argon2id$");
		expect(await openPhc(environment.keys, row as PasswordCredentialRow)).toMatch(
			/^\$argon2id\$v=19\$/,
		);
	}, 30_000);

	// `ON CONFLICT … DO UPDATE … WHERE` does not raise when its predicate is false; it updates
	// nothing. Without the row count the caller is told the password was stored when it was not.
	it("refuses to report success when the upsert changed no row", async () => {
		const silent: Driver = {
			query: async (sql, params) =>
				sql.includes("INSERT") ? [] : recorder.driver.query(sql, params),
			transaction: recorder.driver.transaction,
		};
		const deaf: PasswordEnvironment = {
			...environment,
			credentials: createPasswordCredentialRepository({ driver: silent, keys: environment.keys }),
		};

		await expect(
			setPassword({ userId: USER_ID, plaintext: PASSWORD, setBySessionId: null }, deaf),
		).rejects.toMatchObject({ code: NOT_WRITTEN });
		expect(recorder.rows.get(USER_ID)).toBeUndefined();
	}, 30_000);

	// The column and the credential have to name the same function to verify (E-177); a write that
	// would store a row nobody could ever verify is refused instead of stored.
	it("refuses a scheme column that disagrees with the credential it is written with", async () => {
		await expect(
			environment.credentials.write({
				userId: USER_ID,
				phc: stored.byScheme.argon2i,
				scheme: "argon2id",
				setBySessionId: null,
			}),
		).rejects.toMatchObject({ code: "scheme_does_not_match_credential" });

		await expect(
			environment.credentials.write({
				userId: USER_ID,
				phc: "not a stored hash at all",
				scheme: "argon2id",
				setBySessionId: null,
			}),
		).rejects.toMatchObject({ code: "scheme_does_not_match_credential" });
	});

	it("cannot be read with the key of another purpose", async () => {
		await setPassword({ userId: USER_ID, plaintext: PASSWORD, setBySessionId: null }, environment);
		const row = recorder.rows.get(USER_ID) as PasswordCredentialRow;
		const otherKeys = rootKeyProvider({
			currentVersion: 1,
			keysByVersion: { 1: generateRootKey() },
		});

		await expect(openPhc(otherKeys, row)).rejects.toMatchObject({
			code: "authentication_failed",
		});
	}, 30_000);
});

describe("one code path regardless of the outcome", () => {
	it("issues the same statements for every failing case", async () => {
		await seed(stored.byScheme.argon2id, "argon2id");
		const shapes: string[][] = [];
		const outcomes: PasswordCheck[] = [];

		for (const attempt of [
			{ userId: USER_ID, plaintext: WRONG_PASSWORD },
			{ userId: null, plaintext: WRONG_PASSWORD },
			{ userId: "99999999-9999-9999-9999-999999999999", plaintext: WRONG_PASSWORD },
		]) {
			recorder.calls.length = 0;
			const check = await checkPassword(attempt, environment);
			outcomes.push(check);
			expect(check.outcome).toBe("refused");
			shapes.push(callShapes());
		}

		expect(shapes[0]).toEqual(shapes[1]);
		expect(shapes[1]).toEqual(shapes[2]);
		expect(shapes[0]).toHaveLength(1);
		expect(new Set(outcomes.map((outcome) => outcome.outcome)).size).toBe(1);
	}, 30_000);

	it("asks for a credential even when no user was resolved", async () => {
		await checkPassword({ userId: null, plaintext: WRONG_PASSWORD }, environment);

		expect(recorder.calls).toHaveLength(1);
		expect(recorder.calls[0]?.params[0]).toBe(ABSENT_USER_ID);
	}, 30_000);

	it("verifies against the dummy with the configured parameters, not against a fresh hash", async () => {
		const dummy = parsePhc(await openPhc(environment.keys, environment.dummy));

		expect(dummy?.id).toBe("argon2id");
		expect(dummy?.parameters.get("m")).toBe(String(CHEAP_ARGON2ID.memoryKiB));
		expect(dummy?.parameters.get("t")).toBe(String(CHEAP_ARGON2ID.iterations));
		expect(dummy?.parameters.get("p")).toBe(String(CHEAP_ARGON2ID.parallelism));
		expect(dummy?.salt).toHaveLength(16);
		expect(dummy?.hash).toHaveLength(32);
	});

	it("names the true reason for the log while the caller sees one code", async () => {
		await seed(stored.byScheme.bcrypt, "bcrypt");

		const narrowed = { ...environment, config: resolvePasswordConfig({ acceptLegacy: [] }) };
		const rejected = await checkPassword({ userId: USER_ID, plaintext: PASSWORD }, narrowed);

		expect(rejected).toEqual({ outcome: "refused", reason: "legacy_scheme_rejected" });
	}, 30_000);

	// The gate reads the cleartext `scheme` column, the verifier reads the identifier inside the
	// credential. When the two disagree the credential must lose, or `acceptLegacy` is advisory.
	it("refuses a credential whose identifier disagrees with the column it is filed under", async () => {
		await seed(stored.byScheme.argon2i, "argon2id");
		const narrowed = { ...environment, config: resolvePasswordConfig({ acceptLegacy: [] }) };

		expect(await checkPassword({ userId: USER_ID, plaintext: PASSWORD }, narrowed)).toEqual({
			outcome: "refused",
			reason: "password_mismatch",
		});
		expect(await checkPassword({ userId: USER_ID, plaintext: PASSWORD }, environment)).toEqual({
			outcome: "refused",
			reason: "password_mismatch",
		});
	}, 30_000);

	it("still runs a derivation for a scheme it refuses to accept", async () => {
		await seed(stored.byScheme.bcrypt, "bcrypt");
		const narrowed = { ...environment, config: resolvePasswordConfig({ acceptLegacy: [] }) };

		const before = narrowed.semaphore.peakInFlight;
		await checkPassword({ userId: USER_ID, plaintext: PASSWORD }, narrowed);

		expect(narrowed.semaphore.peakInFlight).toBeGreaterThanOrEqual(before + 1);
	}, 30_000);

	it("separates a missing user from a user without a password only in the log", async () => {
		const withoutUser = await checkPassword(
			{ userId: null, plaintext: WRONG_PASSWORD },
			environment,
		);
		const withoutCredential = await checkPassword(
			{ userId: USER_ID, plaintext: WRONG_PASSWORD },
			environment,
		);

		expect(withoutUser).toEqual({ outcome: "refused", reason: "user_not_found" });
		expect(withoutCredential).toEqual({ outcome: "refused", reason: "no_password_credential" });
	}, 30_000);

	it("refuses a password outside the length limits without any statement or derivation", async () => {
		await seed(stored.byScheme.argon2id, "argon2id");
		const semaphore = environment.semaphore;

		for (const plaintext of ["", "short", "a".repeat(4097), "a".repeat(1024 * 1024)]) {
			recorder.calls.length = 0;
			const check = await checkPassword({ userId: USER_ID, plaintext }, environment);

			expect(check).toEqual({ outcome: "unacceptable" });
			expect(recorder.calls).toEqual([]);
		}

		expect(semaphore.peakInFlight).toBe(0);
	});
});

describe("needsRehash and the silent rehash", () => {
	/** T-REST-7, the needsRehash half: true in both legacy cases, false for the current one. */
	it("is false only for a hash at the current scheme and parameters (S-REST-7)", async () => {
		const config = resolvePasswordConfig({ argon2id: ARGON2ID_FLOOR });

		expect(needsRehash(stored.byScheme.argon2id, config)).toBe(true);
		expect(needsRehash(stored.byScheme.bcrypt, config)).toBe(true);
		expect(needsRehash(stored.byScheme.scrypt, config)).toBe(true);
		expect(needsRehash("not a hash", config)).toBe(true);
		expect(
			needsRehash(
				"$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$AAcOFRwjKjE4P0ZNVFtiaXB3foWMk5qhqK+2vcTL0tk",
				config,
			),
		).toBe(false);
	});

	it("is true when any single parameter is below the policy", () => {
		const config = resolvePasswordConfig({ argon2id: ARGON2ID_FLOOR });

		for (const weaker of ["m=19455,t=2,p=1", "m=19456,t=1,p=1", "m=19456,t=2,p=0"]) {
			const phc = `$argon2id$v=19$${weaker}$c29tZXNhbHRzb21lc2FsdA$AAcOFRwjKjE4P0ZNVFtiaXB3foWMk5qhqK+2vcTL0tk`;
			expect(needsRehash(phc, config), weaker).toBe(true);
		}
	});

	it("hands the caller a task instead of running it inside the sign-in", async () => {
		await seed(stored.byScheme.bcrypt, "bcrypt");
		const before = recorder.rows.get(USER_ID);

		recorder.calls.length = 0;
		const check = await checkPassword({ userId: USER_ID, plaintext: PASSWORD }, environment);

		expect(check.outcome).toBe("verified");
		expect(recorder.rows.get(USER_ID)).toBe(before);
		expect(callShapes().filter((sql) => sql.startsWith("UPDATE"))).toEqual([]);

		if (check.outcome !== "verified" || check.rehash === undefined) {
			throw new Error("an imported bcrypt credential must ask to be rehashed");
		}
		expect(await check.rehash()).toBe(true);

		const after = recorder.rows.get(USER_ID) as PasswordCredentialRow;
		expect(after.scheme).toBe("argon2id");
		expect(await openPhc(environment.keys, after)).toMatch(/^\$argon2id\$v=19\$/);
		expect(await checkPassword({ userId: USER_ID, plaintext: PASSWORD }, environment)).toEqual({
			outcome: "verified",
			userId: USER_ID,
		});
	}, 60_000);

	it("verifies an imported credential on every sign-in until the rehash replaces it", async () => {
		await seed(stored.byScheme.bcrypt, "bcrypt");

		const first = await checkPassword({ userId: USER_ID, plaintext: PASSWORD }, environment);
		const second = await checkPassword({ userId: USER_ID, plaintext: PASSWORD }, environment);

		expect(first.outcome).toBe("verified");
		expect(second.outcome).toBe("verified");
		expect(recorder.rows.get(USER_ID)?.scheme).toBe("bcrypt");
	}, 60_000);

	it("swaps only what it read, so a password changed in between wins", async () => {
		await seed(stored.byScheme.bcrypt, "bcrypt");
		const check = await checkPassword({ userId: USER_ID, plaintext: PASSWORD }, environment);
		if (check.outcome !== "verified" || check.rehash === undefined) {
			throw new Error("an imported bcrypt credential must ask to be rehashed");
		}

		await setPassword(
			{ userId: USER_ID, plaintext: WRONG_PASSWORD, setBySessionId: null },
			environment,
		);
		const chosen = recorder.rows.get(USER_ID);

		expect(await check.rehash()).toBe(false);
		expect(recorder.rows.get(USER_ID)).toBe(chosen);
		expect(
			await checkPassword({ userId: USER_ID, plaintext: WRONG_PASSWORD }, environment),
		).toEqual({ outcome: "verified", userId: USER_ID });
	}, 60_000);

	it("carries key rotation on the same path", async () => {
		await seed(stored.byScheme.argon2id, "argon2id");
		const strong = {
			...environment,
			config: resolvePasswordConfig({ argon2id: CHEAP_ARGON2ID }),
		};
		await setPassword({ userId: USER_ID, plaintext: PASSWORD, setBySessionId: null }, strong);

		const settled = await checkPassword({ userId: USER_ID, plaintext: PASSWORD }, strong);
		expect(settled).toEqual({ outcome: "verified", userId: USER_ID });

		const rotated: PasswordEnvironment = {
			...strong,
			keys: {
				current: async () => ({ ...(await strong.keys.current("password-enc")), version: 2 }),
				byVersion: (purpose, version) =>
					strong.keys.byVersion(purpose, version === 2 ? 1 : version),
			},
		};

		const afterRotation = await checkPassword({ userId: USER_ID, plaintext: PASSWORD }, rotated);
		expect(afterRotation.outcome).toBe("verified");
		expect(afterRotation.outcome === "verified" && afterRotation.rehash).toBeDefined();
	}, 60_000);
});

describe("the key ring is checked at startup, not per sign-in", () => {
	async function keysWithout(versions: readonly number[]): Promise<PasswordEnvironment["keys"]> {
		const inner = environment.keys;
		return {
			current: inner.current.bind(inner),
			byVersion: async (purpose, version) =>
				purpose === "password-enc" && versions.includes(version)
					? null
					: inner.byVersion(purpose, version),
		};
	}

	it("passes when every stored version is in the ring", async () => {
		await setPassword({ userId: USER_ID, plaintext: PASSWORD, setBySessionId: null }, environment);

		await expect(
			assertStoredKeyVersionsAreKnown({ driver: recorder.driver, keys: environment.keys }),
		).resolves.toBeUndefined();
	}, 30_000);

	it("passes on an empty table, and asks the database once", async () => {
		recorder.calls.length = 0;
		const options: StoredKeyVersionCheckOptions = {
			driver: recorder.driver,
			keys: environment.keys,
		};

		await assertStoredKeyVersionsAreKnown(options);

		expect(recorder.calls).toHaveLength(1);
		expect(recorder.calls[0]?.sql).toContain("SELECT DISTINCT key_version");
	});

	it("names every version the ring no longer holds", async () => {
		await setPassword({ userId: USER_ID, plaintext: PASSWORD, setBySessionId: null }, environment);

		const failure = await assertStoredKeyVersionsAreKnown({
			driver: recorder.driver,
			keys: await keysWithout([1]),
		}).catch((thrown: unknown) => thrown);

		expect(failure).toBeInstanceOf(PasswordKeyRingError);
		expect((failure as PasswordKeyRingError).missingVersions).toEqual([1]);
		expect((failure as PasswordKeyRingError).code).toBe("stored_key_version_unknown");
	}, 30_000);

	it("refuses the sign-in without throwing when the check was skipped", async () => {
		await setPassword({ userId: USER_ID, plaintext: PASSWORD, setBySessionId: null }, environment);
		const blinded: PasswordEnvironment = { ...environment, keys: await keysWithout([1]) };

		expect(await checkPassword({ userId: USER_ID, plaintext: PASSWORD }, blinded)).toEqual({
			outcome: "refused",
			reason: "password_mismatch",
		});
		expect(await checkPassword({ userId: null, plaintext: PASSWORD }, blinded)).toEqual({
			outcome: "refused",
			reason: "user_not_found",
		});
	}, 60_000);

	it("costs one decryption attempt whether the key is there or not", async () => {
		await setPassword({ userId: USER_ID, plaintext: PASSWORD, setBySessionId: null }, environment);
		const attempts: number[] = [];

		for (const missing of [[], [1]]) {
			let opened = 0;
			const inner = environment.keys;
			const counted: PasswordEnvironment = {
				...environment,
				keys: {
					current: inner.current.bind(inner),
					byVersion: async (purpose, version) => {
						opened += purpose === "password-enc" ? 1 : 0;
						return missing.includes(version) && purpose === "password-enc"
							? null
							: inner.byVersion(purpose, version);
					},
				},
			};

			await checkPassword({ userId: USER_ID, plaintext: WRONG_PASSWORD }, counted);
			attempts.push(opened);
		}

		expect(attempts[0]).toBe(1);
		expect(attempts[1]).toBe(1);
	}, 60_000);
});
