import { afterAll, describe, expect, it, vi } from "vitest";
import { AUTHENTICATION_TAG_BYTES, NONCE_BYTES } from "../src/core/keys/aes-gcm.js";
import {
	encryptWithPurposeKey,
	openEnvelope,
	randomBytes,
	rootKeyProvider,
	sealEnvelope,
} from "../src/core/keys/index.js";
import { generateRootKey } from "./keys-fixtures.js";

const HEADER_BYTES = 1 + "A256GCM".length + 4;
const DRAWS = 512;

const keys = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });

function hex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function containsSubsequence(haystack: Uint8Array, needle: Uint8Array): boolean {
	return needle.length > 0 && hex(haystack).includes(hex(needle));
}

// A repeated nonce under one AES-GCM key discloses the XOR of the two plaintexts and the
// authentication subkey. The requirement is therefore not "the ciphertexts differ" but "the
// nonces never repeat".
describe("nonce freshness under AES-256-GCM", () => {
	it("draws a different nonce for every value sealed under one key", async () => {
		const plaintext = new TextEncoder().encode("the identical plaintext, sealed again and again");
		const nonces = new Set<string>();

		for (let draw = 0; draw < DRAWS; draw += 1) {
			const envelope = await sealEnvelope(keys, "password-enc", plaintext);
			nonces.add(hex(envelope.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES)));
		}

		expect(nonces.size).toBe(DRAWS);
	});

	it("draws a different nonce in the column shape too", async () => {
		const plaintext = randomBytes(32);
		const nonces = new Set<string>();

		for (let draw = 0; draw < DRAWS; draw += 1) {
			const { ciphertext } = await encryptWithPurposeKey(keys, "totp-enc", plaintext);
			nonces.add(hex(ciphertext.subarray(0, NONCE_BYTES)));
		}

		expect(nonces.size).toBe(DRAWS);
	});

	it("produces a different ciphertext for the same plaintext every time", async () => {
		const plaintext = new TextEncoder().encode("JBSWY3DPEHPK3PXP");
		const sealed = new Set<string>();

		for (let draw = 0; draw < 64; draw += 1) {
			sealed.add(hex(await sealEnvelope(keys, "totp-enc", plaintext)));
		}

		expect(sealed.size).toBe(64);
	});

	it("has a nonce of exactly twelve bytes and a tag of exactly sixteen", async () => {
		for (const length of [0, 1, 16, 47, 512]) {
			const { ciphertext } = await encryptWithPurposeKey(keys, "pkce-enc", randomBytes(length));
			expect(ciphertext.length).toBe(NONCE_BYTES + length + AUTHENTICATION_TAG_BYTES);
		}
	});
});

describe("the ciphertext discloses nothing about the plaintext (S-REST-4)", () => {
	it("does not contain the plaintext as a byte subsequence", async () => {
		const plaintext = new TextEncoder().encode(
			"$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2E$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGE",
		);
		const envelope = await sealEnvelope(keys, "password-enc", plaintext);

		expect(containsSubsequence(envelope, plaintext)).toBe(false);
		expect(new TextDecoder().decode(envelope)).not.toContain("argon2id");
	});

	it("does not contain the derived key as a byte subsequence", async () => {
		const { key } = await keys.current("password-enc");
		const keyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", key));
		const envelope = await sealEnvelope(keys, "password-enc", randomBytes(64));

		expect(containsSubsequence(envelope, keyBytes)).toBe(false);
	});
});

// E-03 and E-58 promise a working `@noble/ciphers` fallback for runtimes whose `crypto.subtle`
// cannot do AES-GCM. The engine is chosen once per process, so the whole module graph is loaded
// again with a `crypto.subtle` that fails the probe.
describe("the envelope path over the noble fallback (E-03, E-58, E-59)", () => {
	afterAll(() => {
		vi.restoreAllMocks();
	});

	it("falls back, and the fallback reads what crypto.subtle wrote", async () => {
		vi.resetModules();
		const probe = vi
			.spyOn(crypto.subtle, "encrypt")
			.mockRejectedValue(new Error("this runtime has no AES-GCM"));

		const aesGcm = await import("../src/core/keys/aes-gcm.js");
		const envelope = await import("../src/core/keys/envelope.js");
		const provider = await import("../src/core/keys/root-key-provider.js");

		expect((await aesGcm.selectAesGcmEngine()).name).toBe("noble");
		probe.mockRestore();

		const rootKey = generateRootKey();
		const fallbackKeys = provider.rootKeyProvider({
			currentVersion: 1,
			keysByVersion: { 1: rootKey },
		});
		const subtleKeys = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: rootKey } });
		const plaintext = randomBytes(80);

		const overNoble = await envelope.sealEnvelope(fallbackKeys, "totp-enc", plaintext);
		expect(await envelope.openEnvelope(fallbackKeys, "totp-enc", overNoble)).toStrictEqual(
			plaintext,
		);
		expect(await openEnvelope(subtleKeys, "totp-enc", overNoble)).toStrictEqual(plaintext);

		const overSubtle = await sealEnvelope(subtleKeys, "totp-enc", plaintext);
		expect(await envelope.openEnvelope(fallbackKeys, "totp-enc", overSubtle)).toStrictEqual(
			plaintext,
		);
	});

	it("still draws a fresh nonce on the fallback path", async () => {
		vi.resetModules();
		const probe = vi
			.spyOn(crypto.subtle, "encrypt")
			.mockRejectedValue(new Error("this runtime has no AES-GCM"));

		const aesGcm = await import("../src/core/keys/aes-gcm.js");
		const envelope = await import("../src/core/keys/envelope.js");
		const provider = await import("../src/core/keys/root-key-provider.js");

		expect((await aesGcm.selectAesGcmEngine()).name).toBe("noble");
		probe.mockRestore();

		const fallbackKeys = provider.rootKeyProvider({
			currentVersion: 1,
			keysByVersion: { 1: generateRootKey() },
		});
		const plaintext = new TextEncoder().encode("the identical plaintext again");
		const nonces = new Set<string>();

		for (let draw = 0; draw < 64; draw += 1) {
			const sealed = await envelope.sealEnvelope(fallbackKeys, "pkce-enc", plaintext);
			nonces.add(hex(sealed.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES)));
		}

		expect(nonces.size).toBe(64);
	});
});
