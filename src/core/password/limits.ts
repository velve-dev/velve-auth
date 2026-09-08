/**
 * S-DOS-3 bounds the memory of the process at semaphore size × the memory parameter, but the
 * parameter of an imported credential is per record and an import decides it. Without a ceiling
 * the real bound is the largest value any import ever wrote, so these are the ceilings the
 * verification path applies to a stored credential (E-182).
 *
 * They are fixed rather than configurable: raising a denial-of-service ceiling is a weakening, and
 * every documented source sits far below them — Better Auth's scrypt at 32 MiB, Firebase at
 * 16 MiB, Django's PBKDF2 at 1.2 million iterations.
 */
export const MAXIMUM_STORED_MEMORY_KIB = 65536;
export const MAXIMUM_STORED_ARGON2_ITERATIONS = 64;
export const MAXIMUM_STORED_PARALLELISM = 64;
export const MAXIMUM_STORED_PBKDF2_ITERATIONS = 2_000_000;
/** bcrypt's cost is an exponent: 14 is about a second, 31 about thirty years on one place. */
export const MAXIMUM_STORED_BCRYPT_COST = 14;

export function argon2CostIsAcceptable(
	memoryKiB: number,
	iterations: number,
	parallelism: number,
): boolean {
	return (
		memoryKiB <= MAXIMUM_STORED_MEMORY_KIB &&
		iterations >= 1 &&
		iterations <= MAXIMUM_STORED_ARGON2_ITERATIONS &&
		parallelism >= 1 &&
		parallelism <= MAXIMUM_STORED_PARALLELISM
	);
}

/** scrypt holds 128 · N · r bytes, and N is two to the cost exponent, which overflows to Infinity
 * for an exponent an import can write in ten digits — the comparison catches that too. */
export function scryptCostIsAcceptable(
	costExponent: number,
	blockSize: number,
	parallelism: number,
): boolean {
	return (
		blockSize >= 1 &&
		parallelism >= 1 &&
		parallelism <= MAXIMUM_STORED_PARALLELISM &&
		(2 ** costExponent * blockSize) / 8 <= MAXIMUM_STORED_MEMORY_KIB
	);
}

export function pbkdf2CostIsAcceptable(iterations: number): boolean {
	return iterations >= 1 && iterations <= MAXIMUM_STORED_PBKDF2_ITERATIONS;
}

const BCRYPT_COST = /^\$2[abyx]\$([0-9]{2})\$/;

export function bcryptCostIsAcceptable(stored: string): boolean {
	const cost = BCRYPT_COST.exec(stored)?.[1];
	return cost !== undefined && Number(cost) >= 4 && Number(cost) <= MAXIMUM_STORED_BCRYPT_COST;
}
