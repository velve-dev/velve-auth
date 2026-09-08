import { compare } from "bcryptjs";
import { bcryptCostIsAcceptable } from "../limits.js";
import type { AcceptedPassword } from "../policy.js";

const CRYPT_BLOWFISH_EIGHT_BIT_REVISION = "$2x$";
const CRYPT_BLOWFISH_ORIGINAL_REVISION = "$2a$";

/**
 * bcrypt is not a PHC string, so the switch hands the stored value over unparsed. Known and
 * documented limitation: bcrypt truncates at 72 bytes, so an imported hash proves only the first
 * 72 bytes of the password; the rehash to Argon2id restores the full length (3.3).
 */
export async function verifyBcrypt(password: AcceptedPassword, stored: string): Promise<boolean> {
	const revised = withVerifiableRevision(stored);

	// The cost is an exponent an import writes, and bcrypt has no memory parameter to bound it by,
	// so an imported `$2a$31$` row would hold a semaphore place for hours (E-182).
	return bcryptCostIsAcceptable(revised) ? compare(password.text, revised) : false;
}

// `$2x$` and `$2a$` differ only in how crypt_blowfish handled bytes with the high bit set, so for
// an ASCII password the two derivations are identical and for any other they cannot collide; the
// rewrite therefore turns a certain failure into a correct answer and never into a false one
// (E-169).
function withVerifiableRevision(stored: string): string {
	return stored.startsWith(CRYPT_BLOWFISH_EIGHT_BIT_REVISION)
		? CRYPT_BLOWFISH_ORIGINAL_REVISION + stored.slice(CRYPT_BLOWFISH_EIGHT_BIT_REVISION.length)
		: stored;
}
