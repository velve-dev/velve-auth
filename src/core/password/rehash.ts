import { ARGON2ID_VERSION, type ResolvedPasswordConfig } from "./config.js";
import type { PasswordCredentialRow } from "./credential.js";
import { integerParameter, parsePhc } from "./phc.js";
import { CREATED_SCHEME } from "./scheme.js";

const REQUIRED_SALT_BYTES = 16;
const REQUIRED_HASH_BYTES = 32;

//an unreadable PHC string needs a rehash as the library cannot describe it
export function needsRehash(phc: string, config: ResolvedPasswordConfig): boolean {
	const parsed = parsePhc(phc);
	if (parsed === null || parsed.id !== CREATED_SCHEME || parsed.version !== ARGON2ID_VERSION) {
		return true;
	}

	const memoryKiB = integerParameter(parsed, "m");
	const iterations = integerParameter(parsed, "t");
	const parallelism = integerParameter(parsed, "p");

	//a memory cost above the configured one is brought down to it as well (S-DOS-3)
	return (
		memoryKiB === null ||
		iterations === null ||
		parallelism === null ||
		memoryKiB !== config.argon2id.memoryKiB ||
		iterations < config.argon2id.iterations ||
		parallelism < config.argon2id.parallelism ||
		(parsed.salt?.length ?? 0) < REQUIRED_SALT_BYTES ||
		(parsed.hash?.length ?? 0) < REQUIRED_HASH_BYTES
	);
}

//a row under an older key version is rewritten at the next successful sign-in (E-12)
export function needsRewrite(
	row: PasswordCredentialRow,
	phc: string,
	currentKeyVersion: number,
	config: ResolvedPasswordConfig,
): boolean {
	return row.keyVersion !== currentKeyVersion || needsRehash(phc, config);
}
