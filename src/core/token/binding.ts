import { macUnderCurrentKey, verifyMacUnderKeyVersion } from "../keys/mac.js";
import type { KeyProvider } from "../keys/provider.js";
import type { OneTimeTokenPayload, OneTimeTokenPurpose } from "./purpose.js";

/** the kind of row a token hash stands in, so a hash moved to another table or purpose fails */
export type TokenBindingPurpose = "session" | "pending_authentication" | OneTimeTokenPurpose;

/** the security-relevant content of a token row, in the form it is stored in */
export type TokenRowContent =
	| { readonly factors: readonly string[]; readonly attempts?: number }
	| { readonly payload: OneTimeTokenPayload | null };

/** everything a token MAC is taken over */
export interface TokenBinding {
	readonly purpose: TokenBindingPurpose;
	readonly ownerId: string | null;
	readonly tokenSha256: Uint8Array;
	readonly content: TokenRowContent;
}

/** the MAC stored beside a token hash and the token-mac version it was taken under */
export interface StoredTokenMac {
	readonly tokenMac: Uint8Array;
	readonly tokenMacKeyVersion: number;
}

/** the place a refused token row was presented at */
export type TokenBindingOccasion = "session_resolve" | "factor_check" | "token_redemption";

/** what a refused token row tells the security-state alarm, and never the token or a hash */
export interface TokenBindingRefusal {
	readonly userId: string;
	readonly occasion: TokenBindingOccasion;
	readonly reason: "token_binding_mismatch";
	readonly verdict: "mismatch" | "key_version_unknown";
}

/** receives every refused token row, and whatever it throws does not change the refusal */
export type TokenBindingRefusalReport = (refusal: TokenBindingRefusal) => void;

const TOKEN_MAC_PURPOSE = "token-mac";

const BINDING_CONTEXT = "velve-auth/token-binding/v1";

const ABSENT = 0x00;
const TEXT = 0x01;
const BYTES = 0x02;
const LIST = 0x03;
const INTEGER = 0x04;

const LENGTH_BYTES = 4;

function field(type: number, length: number, body: Uint8Array): Uint8Array {
	const encoded = new Uint8Array(1 + LENGTH_BYTES + body.length);
	encoded[0] = type;
	new DataView(encoded.buffer).setUint32(1, length, false);
	encoded.set(body, 1 + LENGTH_BYTES);
	return encoded;
}

function textField(value: string): Uint8Array {
	const body = new TextEncoder().encode(value);
	return field(TEXT, body.length, body);
}

function bytesField(value: Uint8Array): Uint8Array {
	return field(BYTES, value.length, value);
}

const ABSENT_FIELD = field(ABSENT, 0, new Uint8Array(0));

const INTEGER_BYTES = 4;

//a count outside a signed 32 bit integer is no value postgres stores in an integer column
function integerField(value: number): Uint8Array {
	if (!Number.isSafeInteger(value) || value < -(2 ** 31) || value >= 2 ** 31) {
		throw new RangeError("a bound integer must fit a signed 32 bit integer");
	}
	const body = new Uint8Array(INTEGER_BYTES);
	new DataView(body.buffer).setInt32(0, value, false);
	return field(INTEGER, INTEGER_BYTES, body);
}

function optionalTextField(value: string | null): Uint8Array {
	return value === null ? ABSENT_FIELD : textField(value);
}

function concatenated(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
	const total = parts.reduce((length, part) => length + part.length, 0);
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.length;
	}
	return joined;
}

//a list keeps its stored order so a reordered or repeated factor no longer verifies
function listField(items: readonly string[]): Uint8Array {
	return concatenated([field(LIST, items.length, new Uint8Array(0)), ...items.map(textField)]);
}

function canonicalJsonOf(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJsonOf).join(",")}]`;
	}
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value).sort(([left], [right]) =>
			left < right ? -1 : left > right ? 1 : 0,
		);
		return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonOf(entry)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

//the payload is read through json first so it is taken in the form jsonb returns it in
export function canonicalPayloadOf(payload: OneTimeTokenPayload | null): string | null {
	return payload === null ? null : canonicalJsonOf(JSON.parse(JSON.stringify(payload)));
}

//a session has no attempt counter so its content is the factor list alone
function contentField(content: TokenRowContent): Uint8Array {
	if (!("factors" in content)) {
		return optionalTextField(canonicalPayloadOf(content.payload));
	}
	return content.attempts === undefined
		? listField(content.factors)
		: concatenated([listField(content.factors), integerField(content.attempts)]);
}

//every field carries its type and length so two different rows never encode alike (S-INTEG-9)
export function encodeTokenBinding(binding: TokenBinding): Uint8Array<ArrayBuffer> {
	return concatenated([
		textField(BINDING_CONTEXT),
		textField(binding.purpose),
		optionalTextField(binding.ownerId),
		bytesField(binding.tokenSha256),
		contentField(binding.content),
	]);
}

export async function bindToken(keys: KeyProvider, binding: TokenBinding): Promise<StoredTokenMac> {
	const { keyVersion, mac } = await macUnderCurrentKey(
		keys,
		TOKEN_MAC_PURPOSE,
		encodeTokenBinding(binding),
	);
	return { tokenMac: mac, tokenMacKeyVersion: keyVersion };
}

/** whether a stored token row was written by the library, checked before anything in it is used */
type TokenBindingVerdict = "valid" | TokenBindingRefusal["verdict"];

export function checkTokenBinding(
	keys: KeyProvider,
	binding: TokenBinding,
	stored: StoredTokenMac,
): Promise<TokenBindingVerdict> {
	return verifyMacUnderKeyVersion(
		keys,
		TOKEN_MAC_PURPOSE,
		{ keyVersion: stored.tokenMacKeyVersion, mac: new Uint8Array(stored.tokenMac) },
		encodeTokenBinding(binding),
	);
}

//a row under an older version is rebound on use so the old version can leave the ring (S-KEY-5)
export async function reboundTokenMacIfStale(
	keys: KeyProvider,
	binding: TokenBinding,
	stored: StoredTokenMac,
): Promise<StoredTokenMac | null> {
	const { version } = await keys.current(TOKEN_MAC_PURPOSE);
	return version === stored.tokenMacKeyVersion ? null : bindToken(keys, binding);
}

//an alarm that throws must not turn a refusal into a different answer (S-INTEG-5)
export function reportRefusedTokenRow(
	report: TokenBindingRefusalReport | undefined,
	refusal: Omit<TokenBindingRefusal, "reason">,
): void {
	try {
		report?.({ ...refusal, reason: "token_binding_mismatch" });
	} catch {
		return;
	}
}
