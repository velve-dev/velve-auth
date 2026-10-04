import { type Argon2Request, type Argon2Variant, deriveArgon2 } from "../argon2.js";
import { argon2CostIsAcceptable } from "../limits.js";
import { integerParameter, type PhcString } from "../phc.js";
import type { AcceptedPassword } from "../policy.js";
import { asDerivedKey, derivedKeysAreEqual } from "../secret.js";

//a missing v field means version 1.0 as in the Argon2 reference decoder (E-173)
const VERSION_WITHOUT_FIELD = 0x10;

const VARIANTS: readonly Argon2Variant[] = ["argon2id", "argon2i", "argon2d"];

type Argon2Inputs = Omit<Argon2Request, "password"> & {
	readonly expected: Uint8Array<ArrayBuffer>;
};

export function readArgon2(stored: PhcString, memoryCeilingKiB: number): Argon2Inputs | null {
	const variant = VARIANTS.find((candidate) => candidate === stored.id);
	const memoryKiB = integerParameter(stored, "m");
	const iterations = integerParameter(stored, "t");
	const parallelism = integerParameter(stored, "p");

	if (
		variant === undefined ||
		memoryKiB === null ||
		iterations === null ||
		parallelism === null ||
		stored.salt === undefined ||
		stored.hash === undefined ||
		!argon2CostIsAcceptable(memoryKiB, iterations, parallelism, memoryCeilingKiB)
	) {
		return null;
	}

	return {
		variant,
		salt: stored.salt,
		memoryKiB,
		iterations,
		parallelism,
		version: stored.version ?? VERSION_WITHOUT_FIELD,
		hashBytes: stored.hash.length,
		expected: stored.hash,
	};
}

export async function verifyArgon2(
	password: AcceptedPassword,
	stored: PhcString,
	memoryCeilingKiB: number,
): Promise<boolean> {
	const inputs = readArgon2(stored, memoryCeilingKiB);
	if (inputs === null) {
		return false;
	}

	const { expected, ...request } = inputs;
	const derived = await deriveArgon2({ ...request, password: password.bytes });

	return derivedKeysAreEqual(derived, asDerivedKey(expected));
}
