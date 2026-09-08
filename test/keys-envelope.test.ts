import { describe, expect, it } from "vitest";
import { AUTHENTICATION_TAG_BYTES, NONCE_BYTES } from "../src/core/keys/aes-gcm.js";
import {
	decryptWithPurposeKey,
	type EncryptionKeyPurpose,
	encryptWithPurposeKey,
	KeyError,
	openEnvelope,
	type PurposeCiphertext,
	randomBytes,
	rootKeyProvider,
	sealEnvelope,
} from "../src/core/keys/index.js";
import { asEncryptionPurpose, generateRootKey, withLastBitFlipped } from "./keys-fixtures.js";

const utf8 = new TextEncoder();
const ENCRYPTION_PURPOSES: EncryptionKeyPurpose[] = [
	"totp-enc",
	"oauth-token-enc",
	"pkce-enc",
	"password-enc",
];

const ALGORITHM_LABEL = "A256GCM";
const VERSION_OFFSET = 1 + ALGORITHM_LABEL.length;
const CIPHERTEXT_OFFSET = VERSION_OFFSET + 4;

function readEnvelopeAlgorithm(envelope: Uint8Array): string {
	return new TextDecoder().decode(envelope.subarray(1, 1 + (envelope[0] ?? 0)));
}

function readEnvelopeKeyVersion(envelope: Uint8Array): number {
	return new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength).getInt32(
		VERSION_OFFSET,
	);
}

async function catchKeyErrorCode(work: Promise<unknown>): Promise<string> {
	try {
		await work;
	} catch (error) {
		expect(error).toBeInstanceOf(KeyError);
		return (error as KeyError).code;
	}

	expect.fail("the operation succeeded where it must fail");
}

describe("envelope encryption (S-KEY-3, E-44)", () => {
	const keys = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });

	it.each(ENCRYPTION_PURPOSES)("round-trips a value under %s", async (purpose) => {
		const plaintext = utf8.encode("JBSWY3DPEHPK3PXP");
		const envelope = await sealEnvelope(keys, purpose, plaintext);
		expect(await openEnvelope(keys, purpose, envelope)).toStrictEqual(plaintext);
	});

	it("round-trips an empty value", async () => {
		const envelope = await sealEnvelope(keys, "pkce-enc", new Uint8Array(0));
		expect(await openEnvelope(keys, "pkce-enc", envelope)).toStrictEqual(new Uint8Array(0));
	});

	it("carries the algorithm label before anything else (section 2.4)", async () => {
		const envelope = await sealEnvelope(keys, "totp-enc", randomBytes(24));
		expect(readEnvelopeAlgorithm(envelope)).toBe(ALGORITHM_LABEL);
	});

	it("carries the key version the provider wrote with", async () => {
		const envelope = await sealEnvelope(keys, "totp-enc", randomBytes(24));
		expect(readEnvelopeKeyVersion(envelope)).toBe((await keys.current("totp-enc")).version);
	});

	it("uses a fresh nonce for every value", async () => {
		const plaintext = utf8.encode("the same plaintext twice");
		const first = await sealEnvelope(keys, "password-enc", plaintext);
		const second = await sealEnvelope(keys, "password-enc", plaintext);
		expect(first).not.toStrictEqual(second);
	});

	it("rejects an envelope naming an unknown algorithm", async () => {
		const envelope = await sealEnvelope(keys, "totp-enc", randomBytes(24));
		envelope.set(utf8.encode("X999GCM"), 1);
		expect(await catchKeyErrorCode(openEnvelope(keys, "totp-enc", envelope))).toBe(
			"envelope_algorithm_unsupported",
		);
	});

	it("rejects an envelope too short to carry a header", async () => {
		expect(await catchKeyErrorCode(openEnvelope(keys, "totp-enc", new Uint8Array(4)))).toBe(
			"envelope_malformed",
		);
	});

	it("rejects a ciphertext too short to carry a nonce and a tag", async () => {
		const truncated = (await sealEnvelope(keys, "totp-enc", randomBytes(24))).subarray(
			0,
			CIPHERTEXT_OFFSET + NONCE_BYTES + AUTHENTICATION_TAG_BYTES - 1,
		);
		expect(await catchKeyErrorCode(openEnvelope(keys, "totp-enc", truncated))).toBe(
			"ciphertext_malformed",
		);
	});

	it("rejects a tampered ciphertext", async () => {
		const envelope = await sealEnvelope(keys, "totp-enc", randomBytes(24));

		expect(
			await catchKeyErrorCode(openEnvelope(keys, "totp-enc", withLastBitFlipped(envelope))),
		).toBe("authentication_failed");
	});

	it("names the tag failure rather than raising the runtime's own exception type", async () => {
		const twoVersions = rootKeyProvider({
			currentVersion: 2,
			keysByVersion: { 1: generateRootKey(), 2: generateRootKey() },
		});
		const envelope = await sealEnvelope(twoVersions, "totp-enc", randomBytes(24));
		const rewrittenVersion = Uint8Array.from(envelope);
		new DataView(rewrittenVersion.buffer).setInt32(VERSION_OFFSET, 1);

		expect(await catchKeyErrorCode(openEnvelope(twoVersions, "pkce-enc", envelope))).toBe(
			"authentication_failed",
		);
		expect(await catchKeyErrorCode(openEnvelope(twoVersions, "totp-enc", rewrittenVersion))).toBe(
			"authentication_failed",
		);
	});
});

describe("column-stored ciphertext (L-2, L-3)", () => {
	const keys = rootKeyProvider({ currentVersion: 7, keysByVersion: { 7: generateRootKey() } });

	it("returns the key version beside the ciphertext", async () => {
		const phc = utf8.encode("$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA");
		const stored: PurposeCiphertext = await encryptWithPurposeKey(keys, "password-enc", phc);

		expect(stored.keyVersion).toBe(7);
		expect(await decryptWithPurposeKey(keys, "password-enc", 7, stored.ciphertext)).toStrictEqual(
			phc,
		);
	});

	it("represents the version the same way the envelope does", async () => {
		const plaintext = randomBytes(48);
		const stored = await encryptWithPurposeKey(keys, "password-enc", plaintext);
		const envelope = await sealEnvelope(keys, "password-enc", plaintext);

		expect(readEnvelopeKeyVersion(envelope)).toBe(stored.keyVersion);
	});

	it("names an unknown version instead of crashing (S-KEY-4)", async () => {
		const stored = await encryptWithPurposeKey(keys, "password-enc", randomBytes(16));

		expect(
			await catchKeyErrorCode(decryptWithPurposeKey(keys, "password-enc", 6, stored.ciphertext)),
		).toBe("key_version_unknown");
	});
});

describe("purpose separation of protected values (S-KEY-2)", () => {
	const keys = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });

	it("does not open a value of one purpose with the key of another", async () => {
		const envelope = await sealEnvelope(keys, "totp-enc", randomBytes(32));

		for (const purpose of ENCRYPTION_PURPOSES.filter((other) => other !== "totp-enc")) {
			await expect(openEnvelope(keys, purpose, envelope)).rejects.toThrow();
		}
	});

	it("names the refusal when a signing purpose reaches the encryption path untyped", async () => {
		for (const purpose of ["cookie-sig", "token-pepper"] as const) {
			expect(
				await catchKeyErrorCode(sealEnvelope(keys, asEncryptionPurpose(purpose), randomBytes(32))),
			).toBe("purpose_cannot_encrypt");
		}
	});
});

describe("root key rotation (S-KEY-5)", () => {
	const first = generateRootKey();
	const second = generateRootKey();

	const beforeRotation = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: first } });
	const duringRotation = rootKeyProvider({
		currentVersion: 2,
		keysByVersion: { 1: first, 2: second },
	});
	const afterRotation = rootKeyProvider({ currentVersion: 2, keysByVersion: { 2: second } });

	it("keeps values readable while both versions are in the ring", async () => {
		const plaintext = randomBytes(64);
		const envelope = await sealEnvelope(beforeRotation, "oauth-token-enc", plaintext);

		expect(await openEnvelope(duringRotation, "oauth-token-enc", envelope)).toStrictEqual(
			plaintext,
		);
	});

	it("writes with the new version once it is current", async () => {
		const envelope = await sealEnvelope(duringRotation, "oauth-token-enc", randomBytes(64));
		expect(readEnvelopeKeyVersion(envelope)).toBe(2);
	});

	it("names the dropped version once it has left the ring", async () => {
		const envelope = await sealEnvelope(beforeRotation, "oauth-token-enc", randomBytes(64));

		expect(await catchKeyErrorCode(openEnvelope(afterRotation, "oauth-token-enc", envelope))).toBe(
			"key_version_unknown",
		);
	});

	it("re-encrypts a value under the new version without touching the plaintext path", async () => {
		const plaintext = randomBytes(64);
		const old = await sealEnvelope(beforeRotation, "oauth-token-enc", plaintext);
		const rotated = await sealEnvelope(
			duringRotation,
			"oauth-token-enc",
			await openEnvelope(duringRotation, "oauth-token-enc", old),
		);

		expect(readEnvelopeKeyVersion(rotated)).toBe(2);
		expect(await openEnvelope(afterRotation, "oauth-token-enc", rotated)).toStrictEqual(plaintext);
	});
});
