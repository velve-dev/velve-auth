import { describe, expect, it } from "vitest";
import {
	decryptWithPurposeKey,
	encryptWithPurposeKey,
	KeyError,
	openEnvelope,
	rootKeyProvider,
	type SigningKeyPurpose,
	sealEnvelope,
} from "../src/core/keys/index.js";
import { randomBytes } from "../src/core/token/index.js";
import { asEncryptionPurpose, generateRootKey } from "./keys-fixtures.js";

const keys = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });

const SIGNING_PURPOSES: readonly SigningKeyPurpose[] = ["cookie-sig", "token-pepper"];

async function thrownBy(work: Promise<unknown>): Promise<unknown> {
	try {
		await work;
	} catch (error) {
		return error;
	}

	return expect.fail("the operation succeeded where it must fail");
}

// `encryptWithPurposeKey`, `sealEnvelope`, `decryptWithPurposeKey` and `openEnvelope` take
// `EncryptionKeyPurpose`, so `sealEnvelope(keys, "cookie-sig", …)` no longer compiles. These cases
// reach the runtime backstop through `asEncryptionPurpose`, which is the only place in the suite
// that defeats the type; they hold the untyped caller to the same contract, a `KeyError` with a
// stable code rather than Web Crypto's uncoded `DOMException: InvalidAccessError`.
describe("encrypting under a signing purpose (repository rules section 3)", () => {
	it.each(SIGNING_PURPOSES)("fails with a KeyError when sealing under %s", async (purpose) => {
		const thrown = await thrownBy(
			sealEnvelope(keys, asEncryptionPurpose(purpose), randomBytes(32)),
		);

		expect(thrown).toBeInstanceOf(KeyError);
	});

	it.each(SIGNING_PURPOSES)(
		"fails with a KeyError in the column shape under %s",
		async (purpose) => {
			const thrown = await thrownBy(
				encryptWithPurposeKey(keys, asEncryptionPurpose(purpose), randomBytes(32)),
			);

			expect(thrown).toBeInstanceOf(KeyError);
		},
	);

	it.each(SIGNING_PURPOSES)("fails with a KeyError when decrypting under %s", async (purpose) => {
		const sealed = await encryptWithPurposeKey(keys, "totp-enc", randomBytes(32));
		const thrown = await thrownBy(
			decryptWithPurposeKey(
				keys,
				asEncryptionPurpose(purpose),
				sealed.keyVersion,
				sealed.ciphertext,
			),
		);

		expect(thrown).toBeInstanceOf(KeyError);
	});
});

// The header is the additional data of every AES-GCM operation (E-65), so anyone who can write the
// column can still rewrite the algorithm label or the key version, but the rewrite fails the
// authentication tag of the value itself. These cases hold that: neither a rewritten version nor a
// rewritten nonce opens.
describe("the envelope header is bound to the ciphertext", () => {
	const VERSION_OFFSET = 1 + "A256GCM".length;

	it("does not silently open a value whose version bytes were rewritten", async () => {
		const twoVersions = rootKeyProvider({
			currentVersion: 2,
			keysByVersion: { 1: generateRootKey(), 2: generateRootKey() },
		});
		const envelope = await sealEnvelope(twoVersions, "totp-enc", randomBytes(32));

		new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength).setInt32(
			VERSION_OFFSET,
			1,
		);

		await expect(openEnvelope(twoVersions, "totp-enc", envelope)).rejects.toThrow();
	});

	it("does not silently open a value whose nonce was rewritten", async () => {
		const envelope = await sealEnvelope(keys, "totp-enc", randomBytes(32));
		const nonceStart = VERSION_OFFSET + 4;
		envelope[nonceStart] = (envelope[nonceStart] ?? 0) ^ 0xff;

		await expect(openEnvelope(keys, "totp-enc", envelope)).rejects.toThrow();
	});
});
