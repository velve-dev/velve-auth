import { ARGON2ID_VERSION, type ResolvedPasswordConfig } from "./config.js";
import type { PasswordCredentialRow } from "./credential.js";
import { integerParameter, parsePhc } from "./phc.js";
import { CREATED_SCHEME } from "./scheme.js";

const REQUIRED_SALT_BYTES = 16;
const REQUIRED_HASH_BYTES = 32;

/**
 * 3.3 step 5: true when the scheme is not the one the library creates, or when any parameter is
 * below the current policy. An unreadable string also counts, because a credential the library
 * cannot describe is one it should replace at the first opportunity.
 */
export function needsRehash(phc: string, config: ResolvedPasswordConfig): boolean {
	const parsed = parsePhc(phc);
	if (parsed === null || parsed.id !== CREATED_SCHEME || parsed.version !== ARGON2ID_VERSION) {
		return true;
	}

	const memoryKiB = integerParameter(parsed, "m");
	const iterations = integerParameter(parsed, "t");
	const parallelism = integerParameter(parsed, "p");

	return (
		memoryKiB === null ||
		iterations === null ||
		parallelism === null ||
		memoryKiB < config.argon2id.memoryKiB ||
		iterations < config.argon2id.iterations ||
		parallelism < config.argon2id.parallelism ||
		(parsed.salt?.length ?? 0) < REQUIRED_SALT_BYTES ||
		(parsed.hash?.length ?? 0) < REQUIRED_HASH_BYTES
	);
}

/**
 * The same path carries key rotation: a row still written under an older `password-enc` version is
 * rewritten on the next successful sign-in, silently and by compare and swap (L-2).
 */
export function needsRewrite(
	row: PasswordCredentialRow,
	phc: string,
	currentKeyVersion: number,
	config: ResolvedPasswordConfig,
): boolean {
	return row.keyVersion !== currentKeyVersion || needsRehash(phc, config);
}
