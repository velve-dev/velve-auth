import { scryptAsync } from "@noble/hashes/scrypt.js";
import { scryptCostIsAcceptable } from "../limits.js";
import { integerParameter, type PhcString } from "../phc.js";
import type { AcceptedPassword } from "../policy.js";
import { asDerivedKey, derivedKeysAreEqual } from "../secret.js";

const ASYNC_TICK_IN_MILLISECONDS = 10;

export async function deriveScrypt(input: {
	readonly password: Uint8Array<ArrayBuffer>;
	readonly salt: Uint8Array<ArrayBuffer>;
	readonly costExponent: number;
	readonly blockSize: number;
	readonly parallelism: number;
	readonly hashBytes: number;
}): Promise<Uint8Array<ArrayBuffer>> {
	return scryptAsync(input.password, input.salt, {
		N: 2 ** input.costExponent,
		r: input.blockSize,
		p: input.parallelism,
		dkLen: input.hashBytes,
		asyncTick: ASYNC_TICK_IN_MILLISECONDS,
	});
}

interface ScryptInputs {
	readonly salt: Uint8Array<ArrayBuffer>;
	readonly expected: Uint8Array<ArrayBuffer>;
	readonly costExponent: number;
	readonly blockSize: number;
	readonly parallelism: number;
}

export function readScrypt(stored: PhcString, memoryCeilingKiB: number): ScryptInputs | null {
	const costExponent = integerParameter(stored, "ln");
	const blockSize = integerParameter(stored, "r");
	const parallelism = integerParameter(stored, "p");

	if (
		costExponent === null ||
		blockSize === null ||
		parallelism === null ||
		stored.salt === undefined ||
		stored.hash === undefined ||
		!scryptCostIsAcceptable(costExponent, blockSize, parallelism, memoryCeilingKiB)
	) {
		return null;
	}

	return { salt: stored.salt, expected: stored.hash, costExponent, blockSize, parallelism };
}

export async function verifyScrypt(
	password: AcceptedPassword,
	stored: PhcString,
	memoryCeilingKiB: number,
): Promise<boolean> {
	const inputs = readScrypt(stored, memoryCeilingKiB);
	if (inputs === null) {
		return false;
	}

	const derived = await deriveScrypt({
		password: password.bytes,
		salt: inputs.salt,
		costExponent: inputs.costExponent,
		blockSize: inputs.blockSize,
		parallelism: inputs.parallelism,
		hashBytes: inputs.expected.length,
	});

	return derivedKeysAreEqual(asDerivedKey(derived), asDerivedKey(inputs.expected));
}
