import { type PhcString, parsePhc } from "./phc.js";
import type { AcceptedPassword } from "./policy.js";
import type { PasswordScheme } from "./scheme.js";
import { readArgon2, verifyArgon2 } from "./verifiers/argon2.js";
import { readBcrypt, verifyBcrypt } from "./verifiers/bcrypt.js";
import { readFirebaseScrypt, verifyFirebaseScrypt } from "./verifiers/fbscrypt.js";
import { readPbkdf2, verifyPbkdf2 } from "./verifiers/pbkdf2.js";
import { readScrypt, verifyScrypt } from "./verifiers/scrypt.js";

interface SchemeVerifier {
	verify(password: AcceptedPassword, stored: string, memoryCeilingKiB: number): Promise<boolean>;
	reachesDerivation(stored: string, memoryCeilingKiB: number): boolean;
}

interface PhcVerifier {
	verify(password: AcceptedPassword, stored: PhcString, memoryCeilingKiB: number): Promise<boolean>;
	read(stored: PhcString, memoryCeilingKiB: number): unknown;
}

//the scheme column must name the same function as the credential it files (E-177)
function overPhc(identifier: PasswordScheme, verifier: PhcVerifier): SchemeVerifier {
	function parsedAs(stored: string): PhcString | null {
		const parsed = parsePhc(stored);
		return parsed === null || parsed.id !== identifier ? null : parsed;
	}

	return {
		async verify(password, stored, memoryCeilingKiB) {
			const parsed = parsedAs(stored);
			return parsed === null ? false : verifier.verify(password, parsed, memoryCeilingKiB);
		},
		reachesDerivation(stored, memoryCeilingKiB) {
			const parsed = parsedAs(stored);
			return parsed !== null && verifier.read(parsed, memoryCeilingKiB) !== null;
		},
	};
}

const ARGON2: PhcVerifier = { verify: verifyArgon2, read: readArgon2 };
const SCRYPT: PhcVerifier = { verify: verifyScrypt, read: readScrypt };
const FIREBASE_SCRYPT: PhcVerifier = { verify: verifyFirebaseScrypt, read: readFirebaseScrypt };
const PBKDF2: PhcVerifier = {
	verify: (password, stored) => verifyPbkdf2(password, stored),
	read: (stored) => readPbkdf2(stored),
};
const BCRYPT: SchemeVerifier = {
	verify: (password, stored) => verifyBcrypt(password, stored),
	reachesDerivation: (stored) => readBcrypt(stored) !== null,
};

//a Map keeps a scheme read from the database off Object.prototype (E-178)
const VERIFIER_BY_SCHEME = new Map<PasswordScheme, SchemeVerifier>([
	["argon2id", overPhc("argon2id", ARGON2)],
	["argon2i", overPhc("argon2i", ARGON2)],
	["argon2d", overPhc("argon2d", ARGON2)],
	["bcrypt", BCRYPT],
	["scrypt", overPhc("scrypt", SCRYPT)],
	["pbkdf2-sha256", overPhc("pbkdf2-sha256", PBKDF2)],
	["pbkdf2-sha512", overPhc("pbkdf2-sha512", PBKDF2)],
	["fbscrypt", overPhc("fbscrypt", FIREBASE_SCRYPT)],
]);

export function credentialReachesDerivation(
	scheme: PasswordScheme,
	stored: string,
	memoryCeilingKiB: number,
): boolean {
	try {
		return VERIFIER_BY_SCHEME.get(scheme)?.reachesDerivation(stored, memoryCeilingKiB) ?? false;
	} catch {
		return false;
	}
}

//every failure answers false and nothing throws in the middle of verification (S-TIM-1)
export async function verifyAgainstScheme(
	scheme: PasswordScheme,
	password: AcceptedPassword,
	stored: string,
	memoryCeilingKiB: number,
): Promise<boolean> {
	const verifier = VERIFIER_BY_SCHEME.get(scheme);
	if (verifier === undefined) {
		return false;
	}

	try {
		return await verifier.verify(password, stored, memoryCeilingKiB);
	} catch {
		return false;
	}
}
