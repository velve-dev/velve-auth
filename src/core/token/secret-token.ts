import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { encodeBase64Url } from "../keys/base64url.js";
import { randomBytes } from "./random.js";

declare const secretTokenBrand: unique symbol;

//an account id must not be usable as a token without an explicit conversion (S-RAND-6)
export type SecretToken = string & { readonly [secretTokenBrand]: "one-time token" };

//a token needs 256 bit from the same source as the session token (S-RAND-4)
const SECRET_TOKEN_BYTES = 32;

export function createSecretToken(): SecretToken {
	return encodeBase64Url(randomBytes(SECRET_TOKEN_BYTES)) as SecretToken;
}

//rejecting a malformed token would be a second answer beside no row (S-REPLAY-3)
export function toSecretToken(value: string): SecretToken {
	return value as SecretToken;
}

export function hashSecretToken(token: SecretToken): Uint8Array {
	return sha256(utf8ToBytes(token));
}
