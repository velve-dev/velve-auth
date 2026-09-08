import { VelveError } from "../http/error-map.js";
import type { PasswordPolicy, ResolvedPasswordConfig } from "./config.js";

export interface AcceptedPassword {
	/** NFKC-normalised, because bcryptjs takes a string and not bytes. */
	readonly text: string;
	readonly bytes: Uint8Array<ArrayBuffer>;
}

const utf8 = new TextEncoder();

const NORMALISATION_SHRINK_BOUND = 4;

/**
 * The sign-in path, and the only entry the hot path uses. It takes a `PasswordPolicy` rather than
 * the whole configuration, so `validate` is not reachable from here at all (L-7).
 */
export function acceptSubmittedPassword(
	plaintext: string,
	policy: PasswordPolicy,
): AcceptedPassword | null {
	// S-DOS-1: the guard exists only to keep a megabyte-sized input out of `normalize`, so it is a
	// bound and not a measurement — UAX #15 caps canonical composition at a threefold shrink in
	// UTF-8, and a UTF-8 encoding is never shorter than the UTF-16 code unit count (E-181).
	if (plaintext.length > policy.maximumLengthInBytes * NORMALISATION_SHRINK_BOUND) {
		return null;
	}

	// NIST SP 800-63B-4 §3.1.1.2, adopted in 3.3: normalise before measuring and before deriving.
	const text = plaintext.normalize("NFKC");
	const bytes = utf8.encode(text);

	if (countCharacters(text) < policy.minimumLength || bytes.length > policy.maximumLengthInBytes) {
		return null;
	}

	return { text, bytes };
}

/**
 * The setting and changing path. It applies the same length limits and then the one hook L-7
 * leaves for an application policy.
 */
export async function acceptNewPassword(
	plaintext: string,
	config: ResolvedPasswordConfig,
): Promise<AcceptedPassword> {
	const accepted = acceptSubmittedPassword(plaintext, config);
	if (accepted === null) {
		throw new VelveError("password_unacceptable");
	}

	if (config.validate !== undefined) {
		try {
			// The hook sees the normalised form, because that is what becomes the credential (E-163).
			await config.validate(accepted.text);
		} catch {
			throw new VelveError("password_unacceptable");
		}
	}

	return accepted;
}

function countCharacters(text: string): number {
	let characters = 0;
	for (const _ of text) {
		characters += 1;
	}
	return characters;
}
