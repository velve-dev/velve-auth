import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "../keys/random.js";

const SESSION_TOKEN_BYTES = 32;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export type SessionToken = string & { readonly __brand: "SessionToken" };

export interface IssuedSessionToken {
	readonly token: SessionToken;
	readonly tokenHash: Uint8Array;
}

/** Encoded here because `btoa` is not among the runtime assumptions of architecture 2.6. */
function encodeBase64Url(bytes: Uint8Array): string {
	let text = "";
	for (let index = 0; index < bytes.length; index += 3) {
		const group =
			((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
		const remaining = bytes.length - index;
		text += BASE64URL_ALPHABET.charAt((group >> 18) & 63);
		text += BASE64URL_ALPHABET.charAt((group >> 12) & 63);
		text += remaining > 1 ? BASE64URL_ALPHABET.charAt((group >> 6) & 63) : "";
		text += remaining > 2 ? BASE64URL_ALPHABET.charAt(group & 63) : "";
	}
	return text;
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
