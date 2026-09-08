import { scryptAsync } from "@noble/hashes/scrypt.js";
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

/** `$scrypt$ln=<exponent>,r=<blockSize>,p=<parallelism>$<salt>$<hash>` — the form an import writes. */
export async function verifyScrypt(
	password: AcceptedPassword,
	stored: PhcString,
): Promise<boolean> {
	const costExponent = integerParameter(stored, "ln");
	const blockSize = integerParameter(stored, "r");
	const parallelism = integerParameter(stored, "p");

	if (
		costExponent === null ||
		blockSize === null ||
		parallelism === null ||
		stored.salt === undefined ||
		stored.hash === undefined
	) {
		return false;
	}

	const derived = await deriveScrypt({
		password: password.bytes,
		salt: stored.salt,
		costExponent,
		blockSize,
		parallelism,
		hashBytes: stored.hash.length,
	});

	return derivedKeysAreEqual(asDerivedKey(derived), asDerivedKey(stored.hash));
}
