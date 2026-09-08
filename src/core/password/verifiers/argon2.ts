import { type Argon2Variant, deriveArgon2 } from "../argon2.js";
import { integerParameter, type PhcString } from "../phc.js";
import type { AcceptedPassword } from "../policy.js";
import { asDerivedKey, derivedKeysAreEqual } from "../secret.js";

/** The Argon2 reference decoder reads a missing `v=` field as version 1.0, and so does this one. */
const VERSION_WITHOUT_FIELD = 0x10;

const VARIANTS: readonly Argon2Variant[] = ["argon2id", "argon2i", "argon2d"];

export async function verifyArgon2(
	password: AcceptedPassword,
	stored: PhcString,
): Promise<boolean> {
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
		stored.hash === undefined
	) {
		return false;
	}

	const derived = await deriveArgon2({
		variant,
		password: password.bytes,
		salt: stored.salt,
		memoryKiB,
		iterations,
		parallelism,
		version: stored.version ?? VERSION_WITHOUT_FIELD,
		hashBytes: stored.hash.length,
	});

	return derivedKeysAreEqual(derived, asDerivedKey(stored.hash));
}
