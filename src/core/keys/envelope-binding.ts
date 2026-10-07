import {
	decryptUnderAdditionalData,
	decryptWithPurposeKey,
	ENVELOPE_ALGORITHM,
	encryptUnderAdditionalData,
	type PurposeCiphertext,
} from "./envelope.js";
import { KeyError } from "./errors.js";
import type { KeyProvider } from "./provider.js";
import type { EncryptionKeyPurpose } from "./purpose.js";

//the column decides the purpose so a binding can never name a key of another column (S-INTEG-1)
const PURPOSE_OF_COLUMN = {
	"password_credential.phc": "password-enc",
	"totp_credential.secret_enc": "totp-enc",
	"identity.access_token_enc": "oauth-token-enc",
	"identity.refresh_token_enc": "oauth-token-enc",
	"identity.id_token_enc": "oauth-token-enc",
	"oauth_flow.pkce_verifier_enc": "pkce-enc",
} as const satisfies Readonly<Record<string, EncryptionKeyPurpose>>;

/** a column that holds an envelope, named as its table and column without the schema */
export type BoundColumn = keyof typeof PURPOSE_OF_COLUMN;

/** the owner, the row and the column a ciphertext is bound to */
export interface EnvelopeBinding {
	readonly column: BoundColumn;
	/** the uuid of the account the row belongs to, or null for a row that has none */
	readonly owner: string | null;
	/** the uuid that identifies the row, or the bytes of a bytea primary key */
	readonly row: string | Uint8Array;
}

/** whether a ciphertext in the unbound form of 1.x is read or refused */
export type UnboundEnvelopeReading = "readable" | "refused";

/** what rewriting one stored envelope into the bound form under the current key came to */
export type RebindOutcome = "rebound" | "current" | "absent" | "lost";

//a bound value carries this first byte and the unbound form a random nonce byte (E-3111)
const BOUND_FORM_MARKER = 0x02;
const BOUND_FORM_CONTEXT = "velve-auth/envelope/v2";

const FIELD_ABSENT = 0x00;
const FIELD_TEXT = 0x01;
const FIELD_UUID = 0x02;
const FIELD_BYTES = 0x03;
const FIELD_INTEGER = 0x04;

const LENGTH_BYTES = 4;
const UUID_BYTES = 16;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const utf8 = new TextEncoder();

function field(type: number, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const written = new Uint8Array(1 + LENGTH_BYTES + bytes.length);
	written[0] = type;
	new DataView(written.buffer).setUint32(1, bytes.length);
	written.set(bytes, 1 + LENGTH_BYTES);
	return written;
}

function uuidBytesOf(uuid: string): Uint8Array<ArrayBuffer> {
	if (!UUID_SHAPE.test(uuid)) {
		throw new KeyError("envelope_binding_malformed");
	}
	const hex = uuid.replaceAll("-", "");
	const bytes = new Uint8Array(UUID_BYTES);
	for (let index = 0; index < UUID_BYTES; index += 1) {
		bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

function integerBytesOf(value: number): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(LENGTH_BYTES);
	new DataView(bytes.buffer).setInt32(0, value);
	return bytes;
}

function ownerField(owner: string | null): Uint8Array<ArrayBuffer> {
	return owner === null
		? field(FIELD_ABSENT, new Uint8Array(0))
		: field(FIELD_UUID, uuidBytesOf(owner));
}

function rowField(row: string | Uint8Array): Uint8Array<ArrayBuffer> {
	return typeof row === "string" ? field(FIELD_UUID, uuidBytesOf(row)) : field(FIELD_BYTES, row);
}

function joined(parts: readonly Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
	const total = parts.reduce((length, part) => length + part.length, 0);
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.length;
	}
	return bytes;
}

/** one column of a row whose identity is several columns, a text, the bytes of a key, or absent */
type RowPart = string | Uint8Array | null;

//a row named by several columns is written as their typed and length prefixed fields in order (E-3123)
export function rowOfParts(parts: readonly RowPart[]): Uint8Array<ArrayBuffer> {
	return joined(
		parts.map((part) => {
			if (part === null) {
				return field(FIELD_ABSENT, new Uint8Array(0));
			}
			return typeof part === "string"
				? field(FIELD_TEXT, utf8.encode(part))
				: field(FIELD_BYTES, part);
		}),
	);
}

//every field is typed and length prefixed in a fixed order so two bindings never share bytes (E-3110)
export function boundAdditionalData(
	binding: EnvelopeBinding,
	keyVersion: number,
): Uint8Array<ArrayBuffer> {
	return joined([
		field(FIELD_TEXT, utf8.encode(BOUND_FORM_CONTEXT)),
		field(FIELD_TEXT, utf8.encode(ENVELOPE_ALGORITHM)),
		field(FIELD_INTEGER, integerBytesOf(keyVersion)),
		field(FIELD_TEXT, utf8.encode(binding.column)),
		ownerField(binding.owner),
		rowField(binding.row),
	]);
}

function purposeOf(binding: EnvelopeBinding): EncryptionKeyPurpose {
	return PURPOSE_OF_COLUMN[binding.column];
}

/** encrypts a value in the bound form, under the current key of the column's purpose */
export async function encryptBound(
	keys: KeyProvider,
	binding: EnvelopeBinding,
	plaintext: Uint8Array<ArrayBuffer>,
): Promise<PurposeCiphertext> {
	const sealed = await encryptUnderAdditionalData(
		keys,
		purposeOf(binding),
		(keyVersion) => boundAdditionalData(binding, keyVersion),
		plaintext,
	);
	const ciphertext = new Uint8Array(1 + sealed.ciphertext.length);
	ciphertext[0] = BOUND_FORM_MARKER;
	ciphertext.set(sealed.ciphertext, 1);
	return { keyVersion: sealed.keyVersion, ciphertext };
}

type StoredForm = "bound" | "unbound";

interface OpenedEnvelope {
	readonly plaintext: Uint8Array<ArrayBuffer>;
	readonly form: StoredForm;
}

function isFailedAuthentication(failure: unknown): boolean {
	return (
		failure instanceof KeyError &&
		(failure.code === "authentication_failed" || failure.code === "ciphertext_malformed")
	);
}

async function openEitherForm(
	keys: KeyProvider,
	binding: EnvelopeBinding,
	stored: PurposeCiphertext,
	unbound: UnboundEnvelopeReading,
): Promise<OpenedEnvelope> {
	const purpose = purposeOf(binding);
	const additionalData = boundAdditionalData(binding, stored.keyVersion);

	if (stored.ciphertext[0] === BOUND_FORM_MARKER) {
		try {
			const plaintext = await decryptUnderAdditionalData(
				keys,
				purpose,
				{ keyVersion: stored.keyVersion, ciphertext: stored.ciphertext.subarray(1) },
				additionalData,
			);
			return { plaintext, form: "bound" };
		} catch (failure) {
			//an unbound value whose nonce opens with the marker is read as unbound only where that form is (E-3111)
			if (unbound === "refused" || !isFailedAuthentication(failure)) {
				throw failure;
			}
		}
	}

	if (unbound === "refused") {
		throw new KeyError("envelope_unbound");
	}
	const plaintext = await decryptWithPurposeKey(
		keys,
		purpose,
		stored.keyVersion,
		stored.ciphertext,
	);
	return { plaintext, form: "unbound" };
}

/** decrypts a value bound to this owner, row and column, or an unbound one where that form is read */
export async function decryptBound(
	keys: KeyProvider,
	binding: EnvelopeBinding,
	stored: PurposeCiphertext,
	unbound: UnboundEnvelopeReading,
): Promise<Uint8Array<ArrayBuffer>> {
	return (await openEitherForm(keys, binding, stored, unbound)).plaintext;
}

/** the bound form of a stored value under the current key, or null when it is that already */
export async function rebindEnvelope(
	keys: KeyProvider,
	binding: EnvelopeBinding,
	stored: PurposeCiphertext,
	unbound: UnboundEnvelopeReading,
): Promise<PurposeCiphertext | null> {
	const opened = await openEitherForm(keys, binding, stored, unbound);
	const current = await keys.current(purposeOf(binding));
	if (opened.form === "bound" && current.version === stored.keyVersion) {
		return null;
	}
	return encryptBound(keys, binding, opened.plaintext);
}
