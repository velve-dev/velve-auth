import { sha256 } from "@noble/hashes/sha2.js";
import { decodeBase64Url, encodeBase64Url } from "../keys/base64url.js";
import { equalsInConstantTime } from "../keys/index.js";
import { randomBytes } from "../token/random.js";

const FLOW_SECRET_BYTES = 32;

const utf8 = new TextEncoder();

//the state is the hash of this pointer, so a leaked state cannot become a pointer (E-546)
type OAuthFlowPointer = string & { readonly __brand: "OAuthFlowPointer" };

//the 256 bits must come from the one CSPRNG module (S-RAND-4)
export function createFlowPointer(): OAuthFlowPointer {
	return encodeBase64Url(randomBytes(FLOW_SECRET_BYTES)) as OAuthFlowPointer;
}

export function stateOfPointer(pointer: string): string {
	return encodeBase64Url(sha256(utf8.encode(pointer)));
}

//the row is found by the state hash and the state itself is never stored (S-REST-2)
export function stateHash(state: string): Uint8Array {
	return sha256(utf8.encode(state));
}

//the cookie is one half of the check and the row the other (S-CSRF-5)
export function pointerBelongsToState(pointer: string, state: string): boolean {
	const claimed = decodeBase64Url(state);
	return claimed !== null && equalsInConstantTime(sha256(utf8.encode(pointer)), claimed);
}

//32 random bytes give 43 characters, inside the length RFC 7636 allows
export function createPkceVerifier(): string {
	return encodeBase64Url(randomBytes(FLOW_SECRET_BYTES));
}

//the challenge is always S256 and no other method exists to fall back to (S-REPLAY-6)
export function pkceChallengeOf(verifier: string): string {
	return encodeBase64Url(sha256(utf8.encode(verifier)));
}

export function createNonce(): string {
	return encodeBase64Url(randomBytes(FLOW_SECRET_BYTES));
}
