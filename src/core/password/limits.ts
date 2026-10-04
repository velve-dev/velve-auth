//an import decides the cost of a stored credential so verification caps it (E-182)
export const MAXIMUM_STORED_MEMORY_KIB = 65536;
export const MAXIMUM_STORED_ARGON2_ITERATIONS = 64;
export const MAXIMUM_STORED_PARALLELISM = 64;
export const MAXIMUM_STORED_PBKDF2_ITERATIONS = 2_000_000;
//bcrypt cost is an exponent and 31 would take about thirty years (E-182)
export const MAXIMUM_STORED_BCRYPT_COST = 14;

//the library verifies every hash it writes so a configured memory above the import ceiling raises it (E-2615)
export function storedMemoryCeilingKiB(configuredMemoryKiB: number): number {
	return Math.max(MAXIMUM_STORED_MEMORY_KIB, configuredMemoryKiB);
}

export function argon2CostIsAcceptable(
	memoryKiB: number,
	iterations: number,
	parallelism: number,
	memoryCeilingKiB = MAXIMUM_STORED_MEMORY_KIB,
): boolean {
	return (
		memoryKiB <= memoryCeilingKiB &&
		iterations >= 1 &&
		iterations <= MAXIMUM_STORED_ARGON2_ITERATIONS &&
		parallelism >= 1 &&
		parallelism <= MAXIMUM_STORED_PARALLELISM
	);
}

//a huge scrypt cost exponent overflows to Infinity and must still be refused (E-182)
export function scryptCostIsAcceptable(
	costExponent: number,
	blockSize: number,
	parallelism: number,
	memoryCeilingKiB = MAXIMUM_STORED_MEMORY_KIB,
): boolean {
	return (
		blockSize >= 1 &&
		parallelism >= 1 &&
		parallelism <= MAXIMUM_STORED_PARALLELISM &&
		(2 ** costExponent * blockSize) / 8 <= memoryCeilingKiB
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
