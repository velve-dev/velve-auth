import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { encodeBase64Url } from "../../keys/base64url.js";
import { randomBytes } from "../../token/random.js";

declare const pendingTokenBrand: unique symbol;

/**
 * S-RAND-6, S-FIX-4: the intermediate state carries a token of its own, and its type is not the
 * session token's type, so neither can be handed to a function expecting the other.
 */
export type PendingToken = string & { readonly [pendingTokenBrand]: "pending authentication" };

const PENDING_TOKEN_BYTES = 32;

export function createPendingToken(): PendingToken {
	return encodeBase64Url(randomBytes(PENDING_TOKEN_BYTES)) as PendingToken;
}

//the shape is unchecked as a rejected shape would be a second answer beside no row (E-260)
export function toPendingToken(value: string): PendingToken {
	return value as PendingToken;
}

//the database sees the hash and never the token (S-REST-2)
export function hashPendingToken(token: PendingToken): Uint8Array {
	return sha256(utf8ToBytes(token));
}
