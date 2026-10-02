//an import decides the cost of a stored credential so verification caps it (E-182)
export const MAXIMUM_STORED_MEMORY_KIB = 65536;
export const MAXIMUM_STORED_ARGON2_ITERATIONS = 64;
export const MAXIMUM_STORED_PARALLELISM = 64;
export const MAXIMUM_STORED_PBKDF2_ITERATIONS = 2_000_000;
//bcrypt cost is an exponent and 31 would take about thirty years (E-182)
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

//a huge scrypt cost exponent overflows to Infinity and must still be refused (E-182)
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
