import { describe, expect, it } from "vitest";
import { assertKeysAnswerForEveryPurpose } from "../src/core/auth/startup.js";
import { macUnderCurrentKey, verifyMacUnderKeyVersion } from "../src/core/keys/mac.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { rootKeyProvider } from "../src/core/keys/root-key-provider.js";
import { generateRootKey } from "./keys-fixtures.js";

// A provider of its own can answer an integrity purpose with a key HMAC cannot use. The start
// refuses it, and a stored MAC checked under such a key is answered with a verdict rather than a
// platform exception (E-3093).

const genuine = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });

async function aesKey(): Promise<CryptoKey> {
	return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

function providerAnsweringStateMacWith(key: CryptoKey): KeyProvider {
	return {
		async current(purpose) {
			return purpose === "state-mac" ? { version: 1, key } : genuine.current(purpose);
		},
		async byVersion(purpose, version) {
			return purpose === "state-mac" ? key : genuine.byVersion(purpose, version);
		},
	};
}

describe("the start check for the integrity purposes (E-3093)", () => {
	it("refuses a provider whose state-mac key cannot take an HMAC", async () => {
		const provider = providerAnsweringStateMacWith(await aesKey());

		await expect(assertKeysAnswerForEveryPurpose(provider)).rejects.toMatchObject({
			code: "keys_unusable",
		});
	});

	it("answers a stored MAC under an unusable key with key_unusable", async () => {
		const taken = await macUnderCurrentKey(genuine, "state-mac", new Uint8Array(8));
		const provider = providerAnsweringStateMacWith(await aesKey());

		await expect(
			verifyMacUnderKeyVersion(provider, "state-mac", taken, new Uint8Array(8)),
		).resolves.toBe("key_unusable");
	});

	it("accepts the provider the library ships", async () => {
		await expect(assertKeysAnswerForEveryPurpose(genuine)).resolves.toBeUndefined();
	});

	it("refuses a token-mac key that verifies but cannot sign", async () => {
		const verifyOnly = await crypto.subtle.importKey(
			"raw",
			new Uint8Array(32),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["verify"],
		);
		const provider: KeyProvider = {
			current: async (purpose) =>
				purpose === "token-mac" ? { version: 1, key: verifyOnly } : genuine.current(purpose),
			byVersion: (purpose, version) => genuine.byVersion(purpose, version),
		};

		await expect(assertKeysAnswerForEveryPurpose(provider)).rejects.toMatchObject({
			code: "keys_unusable",
		});
	});
});
