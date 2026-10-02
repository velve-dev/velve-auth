import { VelveError } from "../http/error-map.js";
import type { PasswordPolicy, ResolvedPasswordConfig } from "./config.js";

export interface AcceptedPassword {
	//bcryptjs takes a string and not bytes so the normalised text is kept too
	readonly text: string;
	readonly bytes: Uint8Array<ArrayBuffer>;
}

const utf8 = new TextEncoder();

const NORMALISATION_SHRINK_BOUND = 4;

//the sign-in path takes only the policy so the validate hook is unreachable here (E-165)
export function acceptSubmittedPassword(
	plaintext: string,
	policy: PasswordPolicy,
): AcceptedPassword | null {
	//this bound only keeps a megabyte input out of normalize and measures nothing (E-181)
	if (plaintext.length > policy.maximumLengthInBytes * NORMALISATION_SHRINK_BOUND) {
		return null;
	}

	//normalisation to NFKC comes before measuring and before deriving
	const text = plaintext.normalize("NFKC");
	const bytes = utf8.encode(text);

	if (countCharacters(text) < policy.minimumLength || bytes.length > policy.maximumLengthInBytes) {
		return null;
	}

	return { text, bytes };
}

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
			//the hook judges the normalised form as that is what becomes the credential (E-163)
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
