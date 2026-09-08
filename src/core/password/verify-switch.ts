import { parsePhc } from "./phc.js";
import type { AcceptedPassword } from "./policy.js";
import type { PasswordScheme } from "./scheme.js";
import { verifyArgon2 } from "./verifiers/argon2.js";
import { verifyBcrypt } from "./verifiers/bcrypt.js";
import { verifyFirebaseScrypt } from "./verifiers/fbscrypt.js";
import { verifyPbkdf2 } from "./verifiers/pbkdf2.js";
import { verifyScrypt } from "./verifiers/scrypt.js";

type SchemeVerifier = (password: AcceptedPassword, stored: string) => Promise<boolean>;

function overPhc(
	verify: (
		password: AcceptedPassword,
		stored: NonNullable<ReturnType<typeof parsePhc>>,
	) => Promise<boolean>,
): SchemeVerifier {
	return async (password, stored) => {
		const parsed = parsePhc(stored);
		return parsed === null ? false : verify(password, parsed);
	};
}

const VERIFIER_BY_SCHEME: Readonly<Record<PasswordScheme, SchemeVerifier>> = {
	argon2id: overPhc(verifyArgon2),
	argon2i: overPhc(verifyArgon2),
	argon2d: overPhc(verifyArgon2),
	bcrypt: verifyBcrypt,
	scrypt: overPhc(verifyScrypt),
	"pbkdf2-sha256": overPhc(verifyPbkdf2),
	"pbkdf2-sha512": overPhc(verifyPbkdf2),
	fbscrypt: overPhc(verifyFirebaseScrypt),
};

/**
 * The switch of 3.3, and the reason creating a hash and verifying one are separate decisions:
 * the scheme lives per record in the stored string, so an import never changes what the library
 * creates for everyone else (E-09).
 *
 * A malformed stored value, an unreadable parameter or a derivation that refuses its own inputs
 * all answer `false` — there is no throw between step 2 and step 4 of the sequence (S-TIM-1).
 */
export async function verifyAgainstScheme(
	scheme: PasswordScheme,
	password: AcceptedPassword,
	stored: string,
): Promise<boolean> {
	try {
		return await VERIFIER_BY_SCHEME[scheme](password, stored);
	} catch {
		return false;
	}
}
