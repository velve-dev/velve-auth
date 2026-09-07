import { gcm } from "@noble/ciphers/aes.js";
import { KeyError } from "./errors.js";
import { randomBytes } from "./random.js";

export const NONCE_BYTES = 12;
export const AUTHENTICATION_TAG_BYTES = 16;

export interface AesGcmEngine {
	readonly name: "subtle" | "noble";
	encrypt(
		key: CryptoKey,
		nonce: Uint8Array<ArrayBuffer>,
		plaintext: Uint8Array<ArrayBuffer>,
	): Promise<Uint8Array<ArrayBuffer>>;
	decrypt(
		key: CryptoKey,
		nonce: Uint8Array<ArrayBuffer>,
		ciphertext: Uint8Array<ArrayBuffer>,
	): Promise<Uint8Array<ArrayBuffer>>;
}

export const subtleAesGcm: AesGcmEngine = {
	name: "subtle",

	async encrypt(key, nonce, plaintext) {
		return new Uint8Array(
			await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext),
		);
	},

	async decrypt(key, nonce, ciphertext) {
		return new Uint8Array(
			await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext),
		);
	},
};

export const nobleAesGcm: AesGcmEngine = {
	name: "noble",

	async encrypt(key, nonce, plaintext) {
		return gcm(await exportRawKey(key), nonce).encrypt(plaintext);
	},

	async decrypt(key, nonce, ciphertext) {
		return gcm(await exportRawKey(key), nonce).decrypt(ciphertext);
	},
};

let engineSelection: Promise<AesGcmEngine> | undefined;

// E-03: `crypto.subtle` is the primary path; `@noble/ciphers` covers runtimes with an incomplete
// Web Crypto implementation.
export function selectAesGcmEngine(): Promise<AesGcmEngine> {
	engineSelection ??= subtleSupportsAesGcm().then((supported) =>
		supported ? subtleAesGcm : nobleAesGcm,
	);
	return engineSelection;
}

async function subtleSupportsAesGcm(): Promise<boolean> {
	try {
		const probeKey = await crypto.subtle.importKey("raw", randomBytes(32), "AES-GCM", false, [
			"encrypt",
		]);
		await subtleAesGcm.encrypt(probeKey, randomBytes(NONCE_BYTES), new Uint8Array(0));
		return true;
	} catch {
		return false;
	}
}

async function exportRawKey(key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
	if (!key.extractable) {
		throw new KeyError("key_material_not_exportable");
	}

	return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}
