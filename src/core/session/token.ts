import { sha256 } from "@noble/hashes/sha2.js";
import { encodeBase64Url } from "../keys/base64url.js";
import { randomBytes } from "../token/random.js";

const SESSION_TOKEN_BYTES = 32;

export type SessionToken = string & { readonly __brand: "SessionToken" };

export interface IssuedSessionToken {
	readonly token: SessionToken;
	readonly tokenHash: Uint8Array;
}

/** S-RAND-1: the 256 bits come from the one CSPRNG module, and the plaintext exists only here and in the cookie. */
export function createSessionToken(): IssuedSessionToken {
	const token = encodeBase64Url(randomBytes(SESSION_TOKEN_BYTES)) as SessionToken;
	return { token, tokenHash: sessionTokenHash(token) };
}

/** S-TIM-4: the database only ever sees this, so no lookup time depends on the plaintext token. */
export function sessionTokenHash(token: string): Uint8Array {
	return sha256(new TextEncoder().encode(token));
}
