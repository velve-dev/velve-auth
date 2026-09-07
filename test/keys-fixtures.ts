import { Buffer } from "node:buffer";
import { randomBytes } from "../src/core/keys/random.js";

export function encodeBase64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

// A test key is drawn per run so that no key material is ever committed.
export function generateRootKey(): string {
	return encodeBase64Url(randomBytes(32));
}

export function withLastBitFlipped(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
	const tampered = Uint8Array.from(bytes);
	const last = tampered.length - 1;
	tampered[last] = (tampered[last] ?? 0) ^ 0b0000_0001;
	return tampered;
}
