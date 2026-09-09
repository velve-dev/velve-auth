import { sha256 } from "@noble/hashes/sha2.js";
import { decodeBase64Url, encodeBase64Url } from "../keys/base64url.js";
import { equalsInConstantTime } from "../keys/index.js";
import { randomBytes } from "../token/random.js";

const FLOW_SECRET_BYTES = 32;

const utf8 = new TextEncoder();

/**
 * The value of `__Host-velve_oauth_state`. It is not the `state` the provider sees: the state is
 * its hash, so 3.10's "the cookie holds only the pointer" is a property of the two values rather
 * than a description of one, and a leaked state cannot be turned back into a pointer (E-546).
 */
type OAuthFlowPointer = string & { readonly __brand: "OAuthFlowPointer" };

/** S-RAND-4: 256 bit from the one CSPRNG module, in the encoding the session token uses. */
export function createFlowPointer(): OAuthFlowPointer {
	return encodeBase64Url(randomBytes(FLOW_SECRET_BYTES)) as OAuthFlowPointer;
}

export function stateOfPointer(pointer: string): string {
	return encodeBase64Url(sha256(utf8.encode(pointer)));
}

/** S-REST-2: `oauth_flow.state_sha256` is what the row is found by, and the state itself is never stored. */
export function stateHash(state: string): Uint8Array {
	return sha256(utf8.encode(state));
}

/** S-CSRF-5: the cookie is one half of the check and the row the other, so this half is compared too. */
export function pointerBelongsToState(pointer: string, state: string): boolean {
	const claimed = decodeBase64Url(state);
	return claimed !== null && equalsInConstantTime(sha256(utf8.encode(pointer)), claimed);
}

/** RFC 7636 §4.1: 43 characters of base64url over 32 random bytes, inside the 43–128 the RFC allows. */
export function createPkceVerifier(): string {
	return encodeBase64Url(randomBytes(FLOW_SECRET_BYTES));
}

/** RFC 7636 §4.2, S256 — 3.10 makes it mandatory, so no `plain` branch exists to fall back to. */
export function pkceChallengeOf(verifier: string): string {
	return encodeBase64Url(sha256(utf8.encode(verifier)));
}

/** The OIDC `nonce`, stored in the flow row and compared against the ID token's claim. */
export function createNonce(): string {
	return encodeBase64Url(randomBytes(FLOW_SECRET_BYTES));
}
