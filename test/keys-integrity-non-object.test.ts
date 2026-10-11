import { describe, expect, it } from "vitest";
import { assertKeysAnswerForEveryPurpose } from "../src/core/auth/startup.js";
import { rootKeyProvider } from "../src/core/keys/index.js";
import { isKeyShaped, keyTakesMac, sameKeyFingerprintOf } from "../src/core/keys/mac.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { generateRootKey } from "./keys-fixtures.js";

//a provider of its own can hand over a value that is not even an object (E-3376)

const genuine = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });

const notObjects: readonly unknown[] = [null, undefined, "HMAC", 7, true];
const objectsWithAStringAlgorithm: readonly unknown[] = [
	{ algorithm: "HMAC", usages: ["sign"] },
	{ algorithm: 7, usages: ["sign"] },
];

describe("isKeyShaped and its callers on a value that is no object", () => {
	it.each(notObjects)("answers false for %s", (value) => {
		expect(isKeyShaped(value)).toBe(false);
	});

	it.each(objectsWithAStringAlgorithm)(
		"answers false for an algorithm that is no object: %j",
		(value) => {
			expect(isKeyShaped(value)).toBe(false);
		},
	);

	it.each(notObjects)(
		"keyTakesMac and sameKeyFingerprintOf answer without throwing for %s",
		async (value) => {
			await expect(keyTakesMac(value as CryptoKey)).resolves.toBe(false);
			await expect(sameKeyFingerprintOf(value as CryptoKey)).resolves.toBeNull();
		},
	);

	it.each(notObjects)(
		"the start refuses a current cookie-sig key of %s with keys_unusable",
		async (value) => {
			const provider: KeyProvider = {
				current: async (purpose) =>
					purpose === "cookie-sig"
						? { version: 1, key: value as CryptoKey }
						: genuine.current(purpose),
				byVersion: (purpose, version) => genuine.byVersion(purpose, version),
			};
			await expect(assertKeysAnswerForEveryPurpose(provider)).rejects.toMatchObject({
				code: "keys_unusable",
			});
		},
	);
});
