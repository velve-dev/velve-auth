import { randomBytes } from "../../token/random.js";

// S-RAND-3: ten codes of 160 bit each, shown in groups.
export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_ENTROPY_BYTES = 20;
export const RECOVERY_CODE_GROUP_LENGTH = 8;

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

function inGroups(encoded: string): string {
	const groups: string[] = [];
	for (let start = 0; start < encoded.length; start += RECOVERY_CODE_GROUP_LENGTH) {
		groups.push(encoded.slice(start, start + RECOVERY_CODE_GROUP_LENGTH));
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

export function formatRecoveryCode(canonical: string): string {
	return inGroups(canonical);
}

// S-RAND-1 and S-RAND-5: the entropy comes from the module every other secret comes from.
export function createRecoveryCodeSet(): readonly string[] {
	const canonical = new Set<string>();
	while (canonical.size < RECOVERY_CODE_COUNT) {
		canonical.add(encodeBase32(randomBytes(RECOVERY_CODE_ENTROPY_BYTES)));
	}
	return [...canonical].map(formatRecoveryCode);
}
