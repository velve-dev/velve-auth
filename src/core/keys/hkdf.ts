import type { KeyPurpose } from "./purpose.js";

const utf8 = new TextEncoder();

const HKDF_SALT = utf8.encode("velve-auth/hkdf-sha256/v1");
const PURPOSE_KEY_BYTES = 32;

// S-KEY-1: one derivation context per purpose, so no two purposes can ever share a key.
function derivationContext(purpose: KeyPurpose): Uint8Array<ArrayBuffer> {
	return utf8.encode(`velve-auth/key/${purpose}`);
}

export async function derivePurposeKeyBytes(
	rootKey: Uint8Array<ArrayBuffer>,
	purpose: KeyPurpose,
): Promise<Uint8Array<ArrayBuffer>> {
	const rootMaterial = await crypto.subtle.importKey("raw", rootKey, "HKDF", false, ["deriveBits"]);

	const derived = await crypto.subtle.deriveBits(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: HKDF_SALT,
			info: derivationContext(purpose),
		},
		rootMaterial,
		PURPOSE_KEY_BYTES * 8,
	);

	return new Uint8Array(derived);
}
