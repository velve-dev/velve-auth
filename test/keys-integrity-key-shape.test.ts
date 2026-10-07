import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertStoredIntegrityKeysTakeMac } from "../src/core/auth/integrity-key-ring.js";
import { assertKeysAnswerForEveryPurpose } from "../src/core/auth/startup.js";
import { macUnderCurrentKey, verifyMacUnderKeyVersion } from "../src/core/keys/mac.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { rootKeyProvider } from "../src/core/keys/root-key-provider.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { generateRootKey } from "./keys-fixtures.js";

// Section 3.18 point 1 makes both integrity purposes HMAC-SHA256 keys, and migration 3 refuses a
// digest that is not 32 bytes. An HMAC key under another hash signs, so the start has to ask for
// the algorithm and the length, and a ring version that stored seals still name has to be probed
// as well as the current one (E-3190, E-3191).

const genuine = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });

let connection: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("integrity_key_shape");
	connection = migrated.connection;
	schema = migrated.schema;
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

async function hmacKeyUnder(hash: "SHA-1" | "SHA-512"): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", new Uint8Array(32).fill(7), { name: "HMAC", hash }, false, [
		"sign",
		"verify",
	]);
}

function providerAnsweringStateMacWith(key: CryptoKey): KeyProvider {
	return {
		current: async (purpose) =>
			purpose === "state-mac" ? { version: 1, key } : genuine.current(purpose),
		byVersion: async (purpose, version) =>
			purpose === "state-mac" ? key : genuine.byVersion(purpose, version),
	};
}

async function aesKey(): Promise<CryptoKey> {
	return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function sealRowUnderKeyVersion(keyVersion: number): Promise<void> {
	const userId = await createUser(connection, schema);
	await connection.query(
		`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
		 VALUES ($1, 1, decode(repeat('00', 32), 'hex'), $2)`,
		[userId, keyVersion],
	);
}

describe("the start check against the HMAC-SHA256 promise of section 3.18 point 1", () => {
	it.each(["SHA-1", "SHA-512"] as const)(
		"refuses a state-mac key that is HMAC under %s",
		async (hash) => {
			const key = await hmacKeyUnder(hash);
			const macLength = (await crypto.subtle.sign("HMAC", key, new Uint8Array(0))).byteLength;
			expect(macLength).not.toBe(32);

			await expect(
				assertKeysAnswerForEveryPurpose(providerAnsweringStateMacWith(key)),
			).rejects.toMatchObject({ code: "keys_unusable" });
		},
	);

	it("answers a stored MAC under an HMAC-SHA-512 key with key_unusable", async () => {
		const taken = await macUnderCurrentKey(genuine, "state-mac", new Uint8Array(8));
		const provider = providerAnsweringStateMacWith(await hmacKeyUnder("SHA-512"));

		await expect(
			verifyMacUnderKeyVersion(provider, "state-mac", taken, new Uint8Array(8)),
		).resolves.toBe("key_unusable");
	});
});

describe("the older ring versions stored seals still name", () => {
	it("refuses a ring whose older state-mac version a seal names cannot take an HMAC", async () => {
		const aes = await aesKey();
		const ring = rootKeyProvider({
			currentVersion: 2,
			keysByVersion: { 1: generateRootKey(), 2: generateRootKey() },
		});
		const provider: KeyProvider = {
			current: (purpose) => ring.current(purpose),
			byVersion: async (purpose, version) =>
				purpose === "state-mac" && version === 1 ? aes : ring.byVersion(purpose, version),
		};
		await sealRowUnderKeyVersion(1);

		await expect(
			assertStoredIntegrityKeysTakeMac({ driver: connection, keys: provider, schema }),
		).rejects.toMatchObject({
			name: "VelveStartupError",
			code: "keys_unusable",
			message:
				"keys answered state-mac version 1, which a stored seal names, with a key that cannot take HMAC-SHA256, so no seal under that version could be checked",
		});
	});

	it("starts when a seal names a version the ring no longer holds, which is a broken state", async () => {
		await sealRowUnderKeyVersion(7);

		await expect(
			assertStoredIntegrityKeysTakeMac({ driver: connection, keys: genuine, schema }),
		).resolves.toBeUndefined();
	});
});

describe("taking a MAC under an unusable current key", () => {
	it("refuses with the KeyError key_unusable rather than a platform exception", async () => {
		const provider = providerAnsweringStateMacWith(await hmacKeyUnder("SHA-1"));

		await expect(
			macUnderCurrentKey(provider, "state-mac", new Uint8Array(8)),
		).rejects.toMatchObject({ name: "KeyError", code: "key_unusable" });
	});
});
