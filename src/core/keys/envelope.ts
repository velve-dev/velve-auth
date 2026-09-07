import { AUTHENTICATION_TAG_BYTES, NONCE_BYTES, selectAesGcmEngine } from "./aes-gcm.js";
import { KeyError } from "./errors.js";
import { isStorableKeyVersion } from "./key-version.js";
import type { KeyProvider } from "./provider.js";
import type { KeyPurpose } from "./purpose.js";
import { randomBytes } from "./random.js";

const ENVELOPE_ALGORITHM = "A256GCM";
const KEY_VERSION_BYTES = 4;

const utf8 = new TextEncoder();
const ALGORITHM_LABEL = utf8.encode(ENVELOPE_ALGORITHM);
const HEADER_BYTES = 1 + ALGORITHM_LABEL.length + KEY_VERSION_BYTES;

export interface PurposeCiphertext {
	keyVersion: number;
	ciphertext: Uint8Array<ArrayBuffer>;
}

// S-KEY-3, column form.
export async function encryptWithPurposeKey(
	keys: KeyProvider,
	purpose: KeyPurpose,
	plaintext: Uint8Array<ArrayBuffer>,
): Promise<PurposeCiphertext> {
	const { version, key } = await keys.current(purpose);
	if (!isStorableKeyVersion(version)) {
		throw new KeyError("key_version_out_of_range");
	}

	const engine = await selectAesGcmEngine();
	const nonce = randomBytes(NONCE_BYTES);
	const sealed = await engine.encrypt(key, nonce, plaintext);

	return { keyVersion: version, ciphertext: concatBytes(nonce, sealed) };
}

export async function decryptWithPurposeKey(
	keys: KeyProvider,
	purpose: KeyPurpose,
	keyVersion: number,
	ciphertext: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
	if (ciphertext.length < NONCE_BYTES + AUTHENTICATION_TAG_BYTES) {
		throw new KeyError("ciphertext_malformed");
	}

	// S-KEY-4: a version that has left the ring is a named error, not a crash.
	const key = await keys.byVersion(purpose, keyVersion);
	if (key === null) {
		throw new KeyError("key_version_unknown");
	}

	const engine = await selectAesGcmEngine();
	return engine.decrypt(key, ciphertext.subarray(0, NONCE_BYTES), ciphertext.subarray(NONCE_BYTES));
}

// S-KEY-3, envelope form. The algorithm label comes first so that a later cipher change leaves
// stored data readable (section 2.4).
export async function sealEnvelope(
	keys: KeyProvider,
	purpose: KeyPurpose,
	plaintext: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
	const { keyVersion, ciphertext } = await encryptWithPurposeKey(keys, purpose, plaintext);
	return concatBytes(writeEnvelopeHeader(keyVersion), ciphertext);
}

export async function openEnvelope(
	keys: KeyProvider,
	purpose: KeyPurpose,
	envelope: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
	const { keyVersion, ciphertext } = readEnvelopeHeader(envelope);
	return decryptWithPurposeKey(keys, purpose, keyVersion, ciphertext);
}

function writeEnvelopeHeader(keyVersion: number): Uint8Array<ArrayBuffer> {
	const header = new Uint8Array(HEADER_BYTES);
	header[0] = ALGORITHM_LABEL.length;
	header.set(ALGORITHM_LABEL, 1);
	new DataView(header.buffer).setInt32(1 + ALGORITHM_LABEL.length, keyVersion);
	return header;
}

function readEnvelopeHeader(envelope: Uint8Array<ArrayBuffer>): PurposeCiphertext {
	const labelLength = envelope[0];
	if (labelLength === undefined || envelope.length < 1 + labelLength + KEY_VERSION_BYTES) {
		throw new KeyError("envelope_malformed");
	}

	const label = new TextDecoder().decode(envelope.subarray(1, 1 + labelLength));
	if (label !== ENVELOPE_ALGORITHM) {
		throw new KeyError("envelope_algorithm_unsupported");
	}

	const view = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);

	return {
		keyVersion: view.getInt32(1 + labelLength),
		ciphertext: envelope.subarray(1 + labelLength + KEY_VERSION_BYTES),
	};
}

function concatBytes(
	left: Uint8Array<ArrayBuffer>,
	right: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
	const joined = new Uint8Array(left.length + right.length);
	joined.set(left);
	joined.set(right, left.length);
	return joined;
}
