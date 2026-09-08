import { PasswordConfigurationError } from "./errors.js";
import { isLegacyScheme, LEGACY_SCHEMES, type LegacyScheme } from "./scheme.js";

export interface Argon2idParameters {
	readonly memoryKiB: number;
	readonly iterations: number;
	readonly parallelism: number;
}

/** OWASP's minimum recommendation (3.3). Configurable upwards only (S-DEFAULT-6). */
export const ARGON2ID_FLOOR: Argon2idParameters = {
	memoryKiB: 19456,
	iterations: 2,
	parallelism: 1,
};

export const ARGON2ID_SALT_BYTES = 16;
export const ARGON2ID_HASH_BYTES = 32;
export const ARGON2ID_VERSION = 0x13;

/** NIST SP 800-63B, adopted as L-7: eight characters, 4096 bytes, no composition rules. */
export const MINIMUM_LENGTH_FLOOR = 8;
export const MAXIMUM_LENGTH_CEILING_IN_BYTES = 4096;

const CONCURRENT_HASH_LIMIT_CEILING = 4;

export interface PasswordPolicy {
	readonly minimumLength: number;
	readonly maximumLengthInBytes: number;
}

export interface PasswordConfig {
	readonly argon2id?: Argon2idParameters;
	readonly acceptLegacy?: readonly LegacyScheme[];
	readonly minimumLength?: number;
	readonly maximumLengthInBytes?: number;
	readonly concurrentHashLimit?: number;
	/** L-7: runs when a password is set and when it is changed, never at sign-in. */
	readonly validate?: (plaintext: string) => Promise<void>;
}

export interface ResolvedPasswordConfig extends PasswordPolicy {
	readonly argon2id: Argon2idParameters;
	readonly acceptLegacy: ReadonlySet<LegacyScheme>;
	readonly concurrentHashLimit: number;
	readonly validate?: (plaintext: string) => Promise<void>;
}

export function resolvePasswordConfig(config: PasswordConfig = {}): ResolvedPasswordConfig {
	const argon2id = config.argon2id ?? ARGON2ID_FLOOR;
	const minimumLength = config.minimumLength ?? MINIMUM_LENGTH_FLOOR;
	const maximumLengthInBytes = config.maximumLengthInBytes ?? MAXIMUM_LENGTH_CEILING_IN_BYTES;
	const concurrentHashLimit = config.concurrentHashLimit ?? defaultConcurrentHashLimit();

	assertAtLeast(argon2id.memoryKiB, ARGON2ID_FLOOR.memoryKiB, "argon2id_memory_below_floor");
	assertAtLeast(argon2id.iterations, ARGON2ID_FLOOR.iterations, "argon2id_iterations_below_floor");
	assertAtLeast(
		argon2id.parallelism,
		ARGON2ID_FLOOR.parallelism,
		"argon2id_parallelism_below_floor",
	);
	assertAtLeast(minimumLength, MINIMUM_LENGTH_FLOOR, "minimum_length_below_floor");

	if (
		!Number.isInteger(maximumLengthInBytes) ||
		maximumLengthInBytes > MAXIMUM_LENGTH_CEILING_IN_BYTES ||
		maximumLengthInBytes < minimumLength
	) {
		throw new PasswordConfigurationError("maximum_length_above_ceiling");
	}

	if (!Number.isInteger(concurrentHashLimit) || concurrentHashLimit < 1) {
		throw new PasswordConfigurationError("concurrent_hash_limit_out_of_range");
	}

	for (const scheme of config.acceptLegacy ?? LEGACY_SCHEMES) {
		if (!isLegacyScheme(scheme)) {
			throw new PasswordConfigurationError("legacy_scheme_unknown");
		}
	}

	return {
		argon2id,
		acceptLegacy: new Set(config.acceptLegacy ?? LEGACY_SCHEMES),
		minimumLength,
		maximumLengthInBytes,
		concurrentHashLimit,
		...(config.validate === undefined ? {} : { validate: config.validate }),
	};
}

// S-DOS-3 sizes the semaphore at `min(4, cpus)`. Node 20 has no `navigator`, so an unknown core
// count falls back to the ceiling rather than to one, which would halve throughput on every
// runtime that does not report (E-162).
function defaultConcurrentHashLimit(): number {
	const reported = globalThis.navigator?.hardwareConcurrency;

	return typeof reported === "number" && reported >= 1
		? Math.min(CONCURRENT_HASH_LIMIT_CEILING, Math.floor(reported))
		: CONCURRENT_HASH_LIMIT_CEILING;
}

function assertAtLeast(
	value: number,
	floor: number,
	code: ConstructorParameters<typeof PasswordConfigurationError>[0],
): void {
	if (!Number.isInteger(value) || value < floor) {
		throw new PasswordConfigurationError(code);
	}
}
