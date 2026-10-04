import { ctr } from "@noble/ciphers/aes.js";
import { scryptCostIsAcceptable } from "../limits.js";
import { bytesParameter, integerParameter, type PhcString } from "../phc.js";
import type { AcceptedPassword } from "../policy.js";
import { asDerivedKey, derivedKeysAreEqual } from "../secret.js";
import { deriveScrypt, scryptCanDerive } from "./scrypt.js";

const DERIVED_BYTES = 64;
const AES_KEY_BYTES = 32;
const COUNTER_BYTES = 16;

interface FirebaseScryptInputs {
	readonly salt: Uint8Array<ArrayBuffer>;
	readonly expected: Uint8Array<ArrayBuffer>;
	readonly saltSeparator: Uint8Array<ArrayBuffer>;
	readonly signerKey: Uint8Array<ArrayBuffer>;
	readonly costExponent: number;
	readonly blockSize: number;
	readonly parallelism: number;
}

export function readFirebaseScrypt(
	stored: PhcString,
	memoryCeilingKiB: number,
): FirebaseScryptInputs | null {
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
		stored.hash === undefined ||
		!scryptCanDerive(costExponent, DERIVED_BYTES) ||
		!scryptCostIsAcceptable(costExponent, blockSize, parallelism, memoryCeilingKiB)
	) {
		return null;
	}

	return {
		salt: stored.salt,
		expected: stored.hash,
		saltSeparator,
		signerKey,
		costExponent,
		blockSize,
		parallelism,
	};
}

//the scrypt n and r are easy to swap and a swapped pair never matches without an error
export async function verifyFirebaseScrypt(
	password: AcceptedPassword,
	stored: PhcString,
	memoryCeilingKiB: number,
): Promise<boolean> {
	const inputs = readFirebaseScrypt(stored, memoryCeilingKiB);
	if (inputs === null) {
		return false;
	}

	const derived = await deriveScrypt({
		password: password.bytes,
		salt: concatBytes(inputs.salt, inputs.saltSeparator),
		costExponent: inputs.costExponent,
		blockSize: inputs.blockSize,
		parallelism: inputs.parallelism,
		hashBytes: DERIVED_BYTES,
	});

	//the signer key is encrypted under the scrypt output and not hashed with it
	const encrypted = await encryptAesCtr(derived.subarray(0, AES_KEY_BYTES), inputs.signerKey);

	return derivedKeysAreEqual(asDerivedKey(encrypted), asDerivedKey(inputs.expected));
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
