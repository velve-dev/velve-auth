import { type Argon2Request, type Argon2Variant, deriveArgon2 } from "../argon2.js";
import { argon2CostIsAcceptable } from "../limits.js";
import { integerParameter, type PhcString } from "../phc.js";
import type { AcceptedPassword } from "../policy.js";
import { asDerivedKey, derivedKeysAreEqual } from "../secret.js";

//a missing v field means version 1.0 as in the Argon2 reference decoder (E-173)
const VERSION_WITHOUT_FIELD = 0x10;

const VARIANTS: readonly Argon2Variant[] = ["argon2id", "argon2i", "argon2d"];
const VERSIONS: readonly number[] = [0x10, 0x13];

//both engines throw before deriving below these so a stored value under them is never handed over (S-TIM-2)
const MINIMUM_SALT_BYTES = 8;
const MINIMUM_HASH_BYTES = 4;
const MINIMUM_MEMORY_KIB_PER_LANE = 8;

type Argon2Inputs = Omit<Argon2Request, "password"> & {
	readonly expected: Uint8Array<ArrayBuffer>;
};

export function readArgon2(stored: PhcString, memoryCeilingKiB: number): Argon2Inputs | null {
	const variant = VARIANTS.find((candidate) => candidate === stored.id);
	const memoryKiB = integerParameter(stored, "m");
	const iterations = integerParameter(stored, "t");
	const parallelism = integerParameter(stored, "p");
	const version = stored.version ?? VERSION_WITHOUT_FIELD;

	if (
		variant === undefined ||
		memoryKiB === null ||
		iterations === null ||
		parallelism === null ||
		stored.salt === undefined ||
		stored.hash === undefined ||
		!VERSIONS.includes(version) ||
		stored.salt.length < MINIMUM_SALT_BYTES ||
		stored.hash.length < MINIMUM_HASH_BYTES ||
		!argon2CostIsAcceptable(memoryKiB, iterations, parallelism, memoryCeilingKiB) ||
		memoryKiB < MINIMUM_MEMORY_KIB_PER_LANE * parallelism
	) {
		return null;
	}

	return {
		variant,
		salt: stored.salt,
		memoryKiB,
		iterations,
		parallelism,
		version,
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
