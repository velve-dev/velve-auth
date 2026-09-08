import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { encodeBase64Url } from "../keys/base64url.js";
import { randomBytes } from "./random.js";

declare const secretTokenBrand: unique symbol;

// S-RAND-6: a database key is not a secret, so an account identifier cannot arrive where a token
// is expected without a conversion someone has to write.
export type SecretToken = string & { readonly [secretTokenBrand]: "one-time token" };

// S-RAND-4: 256 bit, from the same source and in the same encoding as the session token (3.5).
const SECRET_TOKEN_BYTES = 32;

export function createSecretToken(): SecretToken {
	return encodeBase64Url(randomBytes(SECRET_TOKEN_BYTES)) as SecretToken;
}

/** Deliberately unchecked: a rejected shape would be a second answer beside "no row" (S-REPLAY-3). */
export function toSecretToken(value: string): SecretToken {
	return value as SecretToken;
}

export function hashSecretToken(token: SecretToken): Uint8Array {
	return sha256(utf8ToBytes(token));
}
