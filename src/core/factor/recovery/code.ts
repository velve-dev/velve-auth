import { randomBytes } from "../../token/random.js";

// S-RAND-3 and A.8: ten codes of 160 bit each, shown in groups of five.
export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_ENTROPY_BYTES = 20;
export const RECOVERY_CODE_GROUP_SIZE = 5;

/** A.8's `RecoveryCodesConfig`, as the two numbers this module actually uses. */
export interface RecoveryCodeShape {
	readonly count: number;
	readonly groupSize: number;
}

export const DEFAULT_RECOVERY_CODE_SHAPE: RecoveryCodeShape = {
	count: RECOVERY_CODE_COUNT,
	groupSize: RECOVERY_CODE_GROUP_SIZE,
};

/** A count of nothing is a configuration with no way back in, and a group of nothing never ends. */
function positiveWholeOr(configured: number | undefined, fallback: number): number {
	return configured !== undefined && Number.isSafeInteger(configured) && configured > 0
		? configured
		: fallback;
}

export function recoveryCodeShapeOf(
	configured: Partial<RecoveryCodeShape> | undefined,
): RecoveryCodeShape {
	return {
		count: positiveWholeOr(configured?.count, RECOVERY_CODE_COUNT),
		groupSize: positiveWholeOr(configured?.groupSize, RECOVERY_CODE_GROUP_SIZE),
	};
}

/** Crockford's base32: no I, L, O or U, so no character can be read as another one over the phone. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GROUP_SEPARATOR = "-";
const AMBIGUOUS_TO_CANONICAL: Readonly<Record<string, string>> = { I: "1", L: "1", O: "0" };
const NOT_A_CODE_CHARACTER = /[^0-9A-Z]/g;

function encodeBase32(bytes: Uint8Array<ArrayBuffer>): string {
	let bits = 0;
	let accumulator = 0;
	let encoded = "";
	for (const byte of bytes) {
		accumulator = (accumulator << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			encoded += ALPHABET[(accumulator >>> bits) & 31];
		}
	}
	return encoded;
}

function inGroups(encoded: string, groupSize: number): string {
	const groups: string[] = [];
	for (let start = 0; start < encoded.length; start += groupSize) {
		groups.push(encoded.slice(start, start + groupSize));
	}
	return groups.join(GROUP_SEPARATOR);
}

/** What is hashed is the canonical form, so a code retyped without its groups, in lower case or with a transcribed O still finds its row. */
export function normaliseRecoveryCode(submitted: string): string {
	const bare = submitted.toUpperCase().replace(NOT_A_CODE_CHARACTER, "");
	let canonical = "";
	for (const character of bare) {
		canonical += AMBIGUOUS_TO_CANONICAL[character] ?? character;
	}
	return canonical;
}

export function formatRecoveryCode(canonical: string, groupSize: number): string {
	return inGroups(canonical, groupSize);
}

// S-RAND-1 and S-RAND-5: the entropy comes from the module every other secret comes from.
export function createRecoveryCodeSet(shape: RecoveryCodeShape): readonly string[] {
	const canonical = new Set<string>();
	while (canonical.size < shape.count) {
		canonical.add(encodeBase32(randomBytes(RECOVERY_CODE_ENTROPY_BYTES)));
	}
	return [...canonical].map((code) => formatRecoveryCode(code, shape.groupSize));
}
