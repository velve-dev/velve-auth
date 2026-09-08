import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { encodeBase64Url } from "../keys/base64url.js";
import { randomBytes } from "./random.js";

// S-RAND-4: 256 bit, from the same source and in the same encoding as the session token (3.5).
const SECRET_TOKEN_BYTES = 32;

export function createSecretToken(): string {
	return encodeBase64Url(randomBytes(SECRET_TOKEN_BYTES));
}

export function hashSecretToken(token: string): Uint8Array {
	return sha256(utf8ToBytes(token));
}
