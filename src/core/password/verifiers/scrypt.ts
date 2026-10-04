import { scryptAsync } from "@noble/hashes/scrypt.js";
import { scryptCostIsAcceptable } from "../limits.js";
import { integerParameter, type PhcString } from "../phc.js";
import type { AcceptedPassword } from "../policy.js";
import { asDerivedKey, derivedKeysAreEqual } from "../secret.js";

const ASYNC_TICK_IN_MILLISECONDS = 10;
const BYTES_PER_BLOCK_UNIT = 128;

//noble refuses N below 2 and an empty output before deriving so neither is handed over (S-TIM-2)
export function scryptCanDerive(costExponent: number, hashBytes: number): boolean {
	return costExponent >= 1 && hashBytes >= 1;
}

export async function deriveScrypt(input: {
	readonly password: Uint8Array<ArrayBuffer>;
	readonly salt: Uint8Array<ArrayBuffer>;
	readonly costExponent: number;
	readonly blockSize: number;
	readonly parallelism: number;
	readonly hashBytes: number;
}): Promise<Uint8Array<ArrayBuffer>> {
	const costFactor = 2 ** input.costExponent;
	return scryptAsync(input.password, input.salt, {
		N: costFactor,
		r: input.blockSize,
		p: input.parallelism,
		dkLen: input.hashBytes,
		asyncTick: ASYNC_TICK_IN_MILLISECONDS,
		//noble's own memory limit must not refuse what the memory ceiling admitted
		maxmem: BYTES_PER_BLOCK_UNIT * input.blockSize * (costFactor + input.parallelism + 1),
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
		!scryptCanDerive(costExponent, stored.hash.length) ||
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
