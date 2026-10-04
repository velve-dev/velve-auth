import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PhcString } from "../src/core/password/phc.js";

const verified: PhcString[] = [];
let hashesCreated = 0;

//the spies sit on the module boundary the dummy path crosses, so a direct call is counted too
vi.mock("../src/core/password/verifiers/argon2.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../src/core/password/verifiers/argon2.js")>();
	return {
		...original,
		verifyArgon2: (...args: Parameters<typeof original.verifyArgon2>) => {
			verified.push(args[1]);
			return original.verifyArgon2(...args);
		},
	};
});

vi.mock("../src/core/password/argon2.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/core/password/argon2.js")>();
	return {
		...original,
		createArgon2idHash: (...args: Parameters<typeof original.createArgon2idHash>) => {
			hashesCreated += 1;
			return original.createArgon2idHash(...args);
		},
	};
});

import type { Driver } from "../src/core/db/driver.js";
import { MAXIMUM_STORED_MEMORY_KIB } from "../src/core/password/limits.js";
import type { PasswordEnvironment } from "../src/core/password/verify.js";

const { rootKeyProvider } = await import("../src/core/keys/index.js");
const { ARGON2ID_HASH_BYTES, ARGON2ID_SALT_BYTES, resolvePasswordConfig } = await import(
	"../src/core/password/config.js"
);
const { createPasswordCredentialRepository } = await import("../src/core/password/credential.js");
const { createKdfSemaphore } = await import("../src/core/password/semaphore.js");
const { checkPassword, createDummyCredential } = await import("../src/core/password/verify.js");
const { integerParameter } = await import("../src/core/password/phc.js");
const { generateRootKey } = await import("./keys-fixtures.js");
const { drawTestPassword } = await import("./password-fixtures.js");

const PRODUCTION_ARGON2ID = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;

const noRows: Driver = {
	query: () => Promise.resolve([]),
	transaction: (run) => run(noRows),
};

let environment: PasswordEnvironment;
let hashesWhileCreatingTheDummy = 0;

beforeAll(async () => {
	const keys = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });
	const config = resolvePasswordConfig({ argon2id: PRODUCTION_ARGON2ID });
	environment = {
		config,
		keys,
		credentials: createPasswordCredentialRepository({
			driver: noRows,
			keys,
			memoryCeilingKiB: MAXIMUM_STORED_MEMORY_KIB,
		}),
		semaphore: createKdfSemaphore({ limit: config.concurrentHashLimit }),
		dummy: await createDummyCredential(keys, config),
	};
	hashesWhileCreatingTheDummy = hashesCreated;
}, 60_000);

describe("T-TIM-2 — the absent-user path verifies the dummy and never hashes (S-TIM-2)", () => {
	it("sees the one hash that creates the dummy, so a zero below is a count and not a blind spy", () => {
		expect(hashesWhileCreatingTheDummy).toBe(1);
	});

	it("calls verifyArgon2 exactly once and createArgon2idHash not at all", async () => {
		verified.length = 0;
		hashesCreated = 0;

		const check = await checkPassword({ userId: null, plaintext: drawTestPassword() }, environment);

		expect(check).toStrictEqual({ outcome: "refused", reason: "user_not_found" });
		expect({ verify: verified.length, hash: hashesCreated }).toStrictEqual({
			verify: 1,
			hash: 0,
		});
	}, 60_000);

	it("verifies against a PHC whose parameters are exactly the configured ones", async () => {
		verified.length = 0;
		await checkPassword({ userId: null, plaintext: drawTestPassword() }, environment);
		const [stored] = verified;

		expect(stored?.id).toBe("argon2id");
		expect({
			m: stored === undefined ? null : integerParameter(stored, "m"),
			t: stored === undefined ? null : integerParameter(stored, "t"),
			p: stored === undefined ? null : integerParameter(stored, "p"),
			salt: stored?.salt?.length,
			hash: stored?.hash?.length,
		}).toStrictEqual({
			m: PRODUCTION_ARGON2ID.memoryKiB,
			t: PRODUCTION_ARGON2ID.iterations,
			p: PRODUCTION_ARGON2ID.parallelism,
			salt: ARGON2ID_SALT_BYTES,
			hash: ARGON2ID_HASH_BYTES,
		});
	}, 60_000);
});
