import { describe, expect, it } from "vitest";
import {
	type AesGcmEngine,
	NONCE_BYTES,
	nobleAesGcm,
	selectAesGcmEngine,
	subtleAesGcm,
} from "../src/core/keys/aes-gcm.js";
import { KeyError, randomBytes } from "../src/core/keys/index.js";
import { withLastBitFlipped } from "./keys-fixtures.js";

const utf8 = new TextEncoder();

function importAesGcmKey(extractable: boolean): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", randomBytes(32), "AES-GCM", extractable, [
		"encrypt",
		"decrypt",
	]);
}

describe("AES-GCM engines (E-03)", () => {
	const engines: AesGcmEngine[] = [subtleAesGcm, nobleAesGcm];

	it("prefers crypto.subtle where Web Crypto is complete", async () => {
		expect((await selectAesGcmEngine()).name).toBe("subtle");
	});

	it.each(engines)("round-trips a value through $name", async (engine) => {
		const key = await importAesGcmKey(true);
		const nonce = randomBytes(NONCE_BYTES);
		const plaintext = utf8.encode("$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA");

		const sealed = await engine.encrypt(key, nonce, plaintext);
		expect(await engine.decrypt(key, nonce, sealed)).toStrictEqual(plaintext);
	});

	it("produces byte-identical ciphertext in both engines", async () => {
		const key = await importAesGcmKey(true);
		const nonce = randomBytes(NONCE_BYTES);
		const plaintext = randomBytes(96);

		expect(await nobleAesGcm.encrypt(key, nonce, plaintext)).toStrictEqual(
			await subtleAesGcm.encrypt(key, nonce, plaintext),
		);
	});

	it("reads what the other engine wrote", async () => {
		const key = await importAesGcmKey(true);
		const nonce = randomBytes(NONCE_BYTES);
		const plaintext = randomBytes(96);

		const bySubtle = await subtleAesGcm.encrypt(key, nonce, plaintext);
		const byNoble = await nobleAesGcm.encrypt(key, nonce, plaintext);

		expect(await nobleAesGcm.decrypt(key, nonce, bySubtle)).toStrictEqual(plaintext);
		expect(await subtleAesGcm.decrypt(key, nonce, byNoble)).toStrictEqual(plaintext);
	});

	it.each(engines)("rejects a tampered authentication tag in $name", async (engine) => {
		const key = await importAesGcmKey(true);
		const nonce = randomBytes(NONCE_BYTES);
		const sealed = await engine.encrypt(key, nonce, randomBytes(32));

		await expect(engine.decrypt(key, nonce, withLastBitFlipped(sealed))).rejects.toThrow();
	});

	it("names the reason when the fallback cannot read the key material", async () => {
		const key = await importAesGcmKey(false);

		await expect(
			nobleAesGcm.encrypt(key, randomBytes(NONCE_BYTES), randomBytes(16)),
		).rejects.toBeInstanceOf(KeyError);
	});
});
