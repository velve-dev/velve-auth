import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { ConcealedError } from "../../http/error-map.js";
import { isRecord } from "../../http/validators.js";
import { decodeBase64Url } from "../../keys/base64url.js";
import { equalsInConstantTime } from "../../keys/constant-time.js";

const RP_ID_HASH_LENGTH = 32;
const FLAGS_OFFSET = RP_ID_HASH_LENGTH;
const SHORTEST_AUTHENTICATOR_DATA = 37;
const USER_VERIFIED_FLAG = 0b0000_0100;

//an absent field must not be read through a polluted prototype
function ownField(source: Record<string, unknown>, key: string): unknown {
	return Object.hasOwn(source, key) ? source[key] : undefined;
}

export function clientDataOrigin(clientDataJSON: string): string | null {
	const bytes = decodeBase64Url(clientDataJSON);
	if (bytes === null) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
	if (!isRecord(parsed)) {
		return null;
	}
	const origin = ownField(parsed, "origin");
	return typeof origin === "string" ? origin : null;
}

function relyingPartyIdHashOf(authenticatorData: string): Uint8Array<ArrayBuffer> | null {
	const bytes = decodeBase64Url(authenticatorData);
	if (bytes === null || bytes.length < SHORTEST_AUTHENTICATOR_DATA) {
		return null;
	}
	return Uint8Array.from(bytes.subarray(0, RP_ID_HASH_LENGTH));
}

export function userWasVerified(authenticatorData: string): boolean {
	const bytes = decodeBase64Url(authenticatorData);
	if (bytes === null || bytes.length < SHORTEST_AUTHENTICATOR_DATA) {
		return false;
	}
	return ((bytes[FLAGS_OFFSET] ?? 0) & USER_VERIFIED_FLAG) !== 0;
}

//prose from the verifier is never matched so these causes are decided here (E-457)
export function assertOriginIsExpected(clientDataJSON: string, origins: readonly string[]): void {
	const origin = clientDataOrigin(clientDataJSON);
	if (origin === null || !origins.includes(origin)) {
		throw new ConcealedError("origin_mismatch");
	}
}

export function assertRelyingPartyIsExpected(
	authenticatorData: string,
	relyingPartyId: string,
): void {
	const presented = relyingPartyIdHashOf(authenticatorData);
	const expected = sha256(utf8ToBytes(relyingPartyId));
	if (presented === null || !equalsInConstantTime(presented, Uint8Array.from(expected))) {
		throw new ConcealedError("rp_id_mismatch");
	}
}

export function assertUserWasVerified(authenticatorData: string): void {
	if (!userWasVerified(authenticatorData)) {
		throw new ConcealedError("user_not_verified");
	}
}

//the client reports credProps unsigned so only an own rk of true counts and silence refuses (E-3812)
function clientReportsADiscoverableCredential(response: RegistrationResponseJSON): boolean {
	const results = ownField(
		response as unknown as Record<string, unknown>,
		"clientExtensionResults",
	);
	if (!isRecord(results)) {
		return false;
	}
	const credentialProperties = ownField(results, "credProps");
	return isRecord(credentialProperties) && ownField(credentialProperties, "rk") === true;
}

export function assertClientReportsADiscoverableCredential(
	response: RegistrationResponseJSON,
): void {
	if (!clientReportsADiscoverableCredential(response)) {
		throw new ConcealedError("credential_not_discoverable");
	}
}
