import { describe, expect, it } from "vitest";
import { assertKeysAnswerForEveryPurpose } from "../src/core/auth/startup.js";
import { macUnderCurrentKey, verifyMacUnderKeyVersion } from "../src/core/keys/mac.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { rootKeyProvider } from "../src/core/keys/root-key-provider.js";
import { generateRootKey } from "./keys-fixtures.js";

// Reviewer test for E-3088 and the Security state chapter: a custom KeyProvider that answers
// state-mac with a key HMAC cannot use passes the start check, and the MAC module then throws a
// raw platform error on the request path instead of the start refusing. The chapter also says
// verifyMacUnderKeyVersion never throws for a stored value.

const genuine = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });

async function aesKey(): Promise<CryptoKey> {
	return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
		"encrypt",
		"decrypt",
	]);
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

describe("the start check for the integrity purposes (E-3088)", () => {
	it("refuses a provider whose state-mac key cannot take an HMAC", async () => {
		const provider = providerAnsweringStateMacWith(await aesKey());

		await expect(assertKeysAnswerForEveryPurpose(provider)).rejects.toMatchObject({
			code: "keys_unusable",
		});
	});

	it("answers a stored MAC under an unusable key without throwing, as the chapter states", async () => {
		const taken = await macUnderCurrentKey(genuine, "state-mac", new Uint8Array(8));
		const provider = providerAnsweringStateMacWith(await aesKey());

		await expect(
			verifyMacUnderKeyVersion(provider, "state-mac", taken, new Uint8Array(8)),
		).resolves.toBeTypeOf("string");
	});
});
