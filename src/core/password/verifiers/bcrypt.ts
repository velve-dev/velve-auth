import { compare } from "bcryptjs";
import { bcryptCostIsAcceptable } from "../limits.js";
import type { AcceptedPassword } from "../policy.js";

const CRYPT_BLOWFISH_EIGHT_BIT_REVISION = "$2x$";
const CRYPT_BLOWFISH_ORIGINAL_REVISION = "$2a$";

//an imported bcrypt cost has no memory bound and must be capped before use (E-182)
export function readBcrypt(stored: string): string | null {
	const revised = withVerifiableRevision(stored);
	return bcryptCostIsAcceptable(revised) ? revised : null;
}

//bcrypt proves only 72 bytes until the rehash to Argon2id restores the full length
export async function verifyBcrypt(password: AcceptedPassword, stored: string): Promise<boolean> {
	const revised = readBcrypt(stored);
	return revised === null ? false : compare(password.text, revised);
}

//reading $2x$ as $2a$ turns a certain failure into a correct answer and never a false one (E-169)
function withVerifiableRevision(stored: string): string {
	return stored.startsWith(CRYPT_BLOWFISH_EIGHT_BIT_REVISION)
		? CRYPT_BLOWFISH_ORIGINAL_REVISION + stored.slice(CRYPT_BLOWFISH_EIGHT_BIT_REVISION.length)
		: stored;
}
