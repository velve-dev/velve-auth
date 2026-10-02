import { type PhcString, parsePhc } from "./phc.js";
import type { AcceptedPassword } from "./policy.js";
import type { PasswordScheme } from "./scheme.js";
import { verifyArgon2 } from "./verifiers/argon2.js";
import { verifyBcrypt } from "./verifiers/bcrypt.js";
import { verifyFirebaseScrypt } from "./verifiers/fbscrypt.js";
import { verifyPbkdf2 } from "./verifiers/pbkdf2.js";
import { verifyScrypt } from "./verifiers/scrypt.js";

type SchemeVerifier = (password: AcceptedPassword, stored: string) => Promise<boolean>;
type PhcVerifier = (password: AcceptedPassword, stored: PhcString) => Promise<boolean>;

//the scheme column must name the same function as the credential it files (E-177)
function overPhc(identifier: PasswordScheme, verify: PhcVerifier): SchemeVerifier {
	return async (password, stored) => {
		const parsed = parsePhc(stored);
		return parsed === null || parsed.id !== identifier ? false : verify(password, parsed);
	};
}

//a Map keeps a scheme read from the database off Object.prototype (E-178)
const VERIFIER_BY_SCHEME = new Map<PasswordScheme, SchemeVerifier>([
	["argon2id", overPhc("argon2id", verifyArgon2)],
	["argon2i", overPhc("argon2i", verifyArgon2)],
	["argon2d", overPhc("argon2d", verifyArgon2)],
	["bcrypt", verifyBcrypt],
	["scrypt", overPhc("scrypt", verifyScrypt)],
	["pbkdf2-sha256", overPhc("pbkdf2-sha256", verifyPbkdf2)],
	["pbkdf2-sha512", overPhc("pbkdf2-sha512", verifyPbkdf2)],
	["fbscrypt", overPhc("fbscrypt", verifyFirebaseScrypt)],
]);

//every failure answers false and nothing throws in the middle of verification (S-TIM-1)
export async function verifyAgainstScheme(
	scheme: PasswordScheme,
	password: AcceptedPassword,
	stored: string,
): Promise<boolean> {
	const verify = VERIFIER_BY_SCHEME.get(scheme);
	if (verify === undefined) {
		return false;
	}

	try {
		return await verify(password, stored);
	} catch {
		return false;
	}
}
