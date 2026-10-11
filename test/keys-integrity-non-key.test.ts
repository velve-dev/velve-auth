import { describe, expect, it } from "vitest";
import { assertStoredIntegrityKeysTakeMac } from "../src/core/auth/integrity-key-ring.js";
import { assertKeysAnswerForEveryPurpose } from "../src/core/auth/startup.js";
import type { Driver } from "../src/core/db/driver.js";
import { macUnderCurrentKey, verifyMacUnderKeyVersion } from "../src/core/keys/mac.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { rootKeyProvider } from "../src/core/keys/root-key-provider.js";
import { generateRootKey } from "./keys-fixtures.js";

//a value that is no key is unusable and a relabelled seal under an unnamed version is a named limit (E-3345)

const genuine = rootKeyProvider({
	currentVersion: 2,
	keysByVersion: { 1: generateRootKey(), 2: generateRootKey() },
});

function sealRowsNaming(...versions: number[]): Driver {
	return {
		query: async <T>() =>
			versions.map((key_version) => ({ purpose: "state-mac", key_version })) as T[],
		transaction: () => Promise.reject(new Error("not used")),
	};
}

describe("a provider answering a purpose with something that is not a CryptoKey", () => {
	it("refuses the start with keys_unusable rather than a TypeError", async () => {
		const provider: KeyProvider = {
			current: async (purpose) =>
				purpose === "cookie-sig" ? { version: 2, key: {} as CryptoKey } : genuine.current(purpose),
			byVersion: (purpose, version) => genuine.byVersion(purpose, version),
		};
		await expect(assertKeysAnswerForEveryPurpose(provider)).rejects.toMatchObject({
			code: "keys_unusable",
		});
	});

	it("answers a stored MAC under such a key with key_unusable rather than a TypeError", async () => {
		const taken = await macUnderCurrentKey(genuine, "state-mac", new Uint8Array(4));
		const provider: KeyProvider = {
			current: (purpose) => genuine.current(purpose),
			byVersion: async (purpose, version) =>
				purpose === "state-mac" ? ({} as CryptoKey) : genuine.byVersion(purpose, version),
		};
		await expect(
			verifyMacUnderKeyVersion(provider, "state-mac", taken, new Uint8Array(4)),
		).resolves.toBe("key_unusable");
	});
});

describe("characterization of a named limit: an older state-mac version no seal row names at start", () => {
	it("starts although the ring answers it with the current token-mac key, so a writer who relabels a seal to it forges a valid one", async () => {
		const tokenMacKey = (await genuine.current("token-mac")).key;
		const provider: KeyProvider = {
			current: (purpose) => genuine.current(purpose),
			byVersion: async (purpose, version) =>
				purpose === "state-mac" && version === 1
					? tokenMacKey
					: genuine.byVersion(purpose, version),
		};
		const message = new Uint8Array([1, 2, 3]);
		const tokenMac = await macUnderCurrentKey(provider, "token-mac", message);
		const relabelled = await verifyMacUnderKeyVersion(
			provider,
			"state-mac",
			{ keyVersion: 1, mac: tokenMac.mac },
			message,
		);
		expect(relabelled).toBe("valid");

		const startRefused = await Promise.all([
			assertKeysAnswerForEveryPurpose(provider),
			assertStoredIntegrityKeysTakeMac({
				driver: sealRowsNaming(2),
				keys: provider,
				schema: "velve",
			}),
		]).then(
			() => false,
			() => true,
		);
		expect(startRefused).toBe(false);
	});
});
