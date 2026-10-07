import { describe, expect, it } from "vitest";
import { assertStoredIntegrityKeysTakeMac } from "../src/core/auth/integrity-key-ring.js";
import { assertKeysAnswerForEveryPurpose } from "../src/core/auth/startup.js";
import type { Driver } from "../src/core/db/driver.js";
import { macUnderCurrentKey } from "../src/core/keys/mac.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { rootKeyProvider } from "../src/core/keys/root-key-provider.js";
import { generateRootKey } from "./keys-fixtures.js";

//a key the start accepts for an integrity purpose is one every later check can use (E-3329)

const genuine = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });

describe("what the start accepts for the integrity purposes", () => {
	it("refuses a current state-mac version no key_version column can hold, which every seal write refuses", async () => {
		const unstorable = 2_147_483_648;
		const provider: KeyProvider = {
			current: async (purpose) =>
				purpose === "state-mac"
					? { version: unstorable, key: (await genuine.current("state-mac")).key }
					: genuine.current(purpose),
			byVersion: (purpose, version) => genuine.byVersion(purpose, version),
		};
		await expect(macUnderCurrentKey(provider, "state-mac", new Uint8Array(1))).rejects.toThrow();
		await expect(assertKeysAnswerForEveryPurpose(provider)).rejects.toMatchObject({
			code: "keys_unusable",
		});
	});

	it("refuses a ring whose stored state-mac version is answered with the token-mac key", async () => {
		const tokenMacKey = (await genuine.current("token-mac")).key;
		const provider: KeyProvider = {
			current: async (purpose) =>
				purpose === "state-mac"
					? { version: 2, key: (await genuine.current("state-mac")).key }
					: genuine.current(purpose),
			byVersion: async (purpose, version) =>
				purpose === "state-mac" && version === 1
					? tokenMacKey
					: genuine.byVersion(purpose, version),
		};
		const driver: Driver = {
			query: async <T>() => [{ key_version: 1 }] as T[],
			transaction: () => Promise.reject(new Error("not used")),
		};
		await expect(assertKeysAnswerForEveryPurpose(provider)).resolves.toBeUndefined();
		await expect(
			assertStoredIntegrityKeysTakeMac({ driver, keys: provider, schema: "velve" }),
		).rejects.toMatchObject({ code: "keys_unusable" });
	});
});
