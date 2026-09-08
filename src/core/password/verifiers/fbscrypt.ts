import { ctr } from "@noble/ciphers/aes.js";
import { bytesParameter, integerParameter, type PhcString } from "../phc.js";
import type { AcceptedPassword } from "../policy.js";
import { asDerivedKey, derivedKeysAreEqual } from "../secret.js";
import { deriveScrypt } from "./scrypt.js";

const DERIVED_BYTES = 64;
const AES_KEY_BYTES = 32;
const COUNTER_BYTES = 16;

/**
 * Firebase's modified scrypt, in the spelling GoTrue writes, so that a Supabase estate carrying
 * `$fbscrypt$` transfers unchanged (4.4 d). `n` is the exponent of `N`, `r` is scrypt's block size:
 * the pair is easy to swap, and a swapped pair produces no error, only hashes that never match.
 */
export async function verifyFirebaseScrypt(
	password: AcceptedPassword,
	stored: PhcString,
): Promise<boolean> {
	const costExponent = integerParameter(stored, "n");
	const blockSize = integerParameter(stored, "r");
	const parallelism = integerParameter(stored, "p");
	const saltSeparator = bytesParameter(stored, "ss");
	const signerKey = bytesParameter(stored, "sk");

	if (
		costExponent === null ||
		blockSize === null ||
		parallelism === null ||
		saltSeparator === null ||
		signerKey === null ||
		stored.salt === undefined ||
		stored.hash === undefined
	) {
		return false;
	}

	const derived = await deriveScrypt({
		password: password.bytes,
		salt: concatBytes(stored.salt, saltSeparator),
		costExponent,
		blockSize,
		parallelism,
		hashBytes: DERIVED_BYTES,
	});

	// The signer key is encrypted under the scrypt output, not hashed with it (4.4 d, step 4).
	const encrypted = await encryptAesCtr(derived.subarray(0, AES_KEY_BYTES), signerKey);

	return derivedKeysAreEqual(asDerivedKey(encrypted), asDerivedKey(stored.hash));
}

async function encryptAesCtr(
	key: Uint8Array<ArrayBuffer>,
	plaintext: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
	const counter = new Uint8Array(COUNTER_BYTES);

	try {
		const imported = await crypto.subtle.importKey("raw", key, "AES-CTR", false, ["encrypt"]);

		return new Uint8Array(
			await crypto.subtle.encrypt(
				{ name: "AES-CTR", counter, length: COUNTER_BYTES * 8 },
				imported,
				plaintext,
			),
		);
	} catch {
		return ctr(key, counter).encrypt(plaintext);
	}
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
