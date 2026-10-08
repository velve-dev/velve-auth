/** the password credential as the seal covers it */
interface SealedPassword {
	readonly phcSha256: Uint8Array;
	readonly keyVersion: number;
	readonly setBySessionId: string | null;
}

/** the TOTP secret as the seal covers it */
interface SealedTotp {
	readonly confirmed: boolean;
	readonly secretSha256: Uint8Array;
	readonly keyVersion: number;
}

/** one passkey as the seal covers it */
interface SealedPasskey {
	readonly credentialId: Uint8Array;
	readonly publicKey: Uint8Array;
}

/** one identity as the seal covers it */
interface SealedIdentity {
	readonly provider: string;
	readonly subject: string;
}

/** one recovery code as the seal covers it */
interface SealedRecoveryCode {
	readonly keyVersion: number;
	readonly codeHmac: Uint8Array;
}

/** every way into an account the seal covers, without the seal row's own version and epoch */
export interface SealedComponents {
	readonly email: string | null;
	readonly emailVerified: boolean;
	readonly disabled: boolean;
	readonly password: SealedPassword | null;
	readonly passwordResetRequired: boolean;
	readonly totp: SealedTotp | null;
	readonly passkeys: readonly SealedPasskey[];
	readonly identities: readonly SealedIdentity[];
	readonly recoveryCodes: readonly SealedRecoveryCode[];
}

/** the whole state one seal digest is taken over */
export interface SecurityState extends SealedComponents {
	readonly userId: string;
	readonly version: number;
	readonly sessionEpoch: number;
}

const SEAL_CONTEXT = "velve-auth/security-state/v1";

const ABSENT = 0x00;
const TEXT = 0x01;
const BYTES = 0x02;
const LIST = 0x03;
const INTEGER = 0x04;
const BOOLEAN = 0x05;
const UUID = 0x06;
const RECORD = 0x07;

const LENGTH_BYTES = 4;
const INTEGER_BYTES = 8;
const SHA256_BYTES = 32;

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const utf8 = new TextEncoder();

function field(type: number, length: number, body: Uint8Array): Uint8Array {
	const encoded = new Uint8Array(1 + LENGTH_BYTES + body.length);
	encoded[0] = type;
	new DataView(encoded.buffer).setUint32(1, length, false);
	encoded.set(body, 1 + LENGTH_BYTES);
	return encoded;
}

function concatenated(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
	const joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.length;
	}
	return joined;
}

const ABSENT_FIELD = field(ABSENT, 0, new Uint8Array(0));

function textField(value: string): Uint8Array {
	const body = utf8.encode(value);
	return field(TEXT, body.length, body);
}

function bytesField(value: Uint8Array): Uint8Array {
	return field(BYTES, value.length, value);
}

function digestField(value: Uint8Array): Uint8Array {
	if (value.length !== SHA256_BYTES) {
		throw new RangeError("a sealed ciphertext is covered by its 32-byte SHA-256 value");
	}
	return bytesField(value);
}

//a value past the exact javascript integers would encode a number nobody stored
function integerField(value: number): Uint8Array {
	if (!Number.isSafeInteger(value)) {
		throw new RangeError("a sealed integer must be an exact integer");
	}
	const body = new Uint8Array(INTEGER_BYTES);
	new DataView(body.buffer).setBigInt64(0, BigInt(value), false);
	return field(INTEGER, INTEGER_BYTES, body);
}

function booleanField(value: boolean): Uint8Array {
	return field(BOOLEAN, 1, new Uint8Array([value ? 1 : 0]));
}

//an identifier spelled in another case is the same identifier and has one encoding
function uuidField(value: string): Uint8Array {
	const normalised = value.toLowerCase();
	if (!UUID_TEXT.test(normalised)) {
		throw new RangeError("a sealed identifier must be a uuid");
	}
	const hex = normalised.replaceAll("-", "");
	const body = new Uint8Array(16);
	for (let index = 0; index < body.length; index += 1) {
		body[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	return field(UUID, body.length, body);
}

function recordField(parts: readonly Uint8Array[]): Uint8Array {
	const body = concatenated(parts);
	return field(RECORD, body.length, body);
}

function inEncodingOrder(left: Uint8Array, right: Uint8Array): number {
	const shared = Math.min(left.length, right.length);
	for (let index = 0; index < shared; index += 1) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) {
			return difference;
		}
	}
	return left.length - right.length;
}

//the order the database returns rows in must not change the seal (S-INTEG-2)
function listField(elements: readonly Uint8Array[]): Uint8Array {
	const sorted = [...elements].sort(inEncodingOrder);
	return concatenated([field(LIST, sorted.length, new Uint8Array(0)), ...sorted]);
}

function passwordField(password: SealedPassword | null): Uint8Array {
	return password === null
		? ABSENT_FIELD
		: recordField([
				digestField(password.phcSha256),
				integerField(password.keyVersion),
				password.setBySessionId === null ? ABSENT_FIELD : uuidField(password.setBySessionId),
			]);
}

function totpField(totp: SealedTotp | null): Uint8Array {
	return totp === null
		? ABSENT_FIELD
		: recordField([
				booleanField(totp.confirmed),
				digestField(totp.secretSha256),
				integerField(totp.keyVersion),
			]);
}

//no two different states may share an encoding (S-INTEG-2)
export function encodeSecurityState(state: SecurityState): Uint8Array<ArrayBuffer> {
	return concatenated([
		textField(SEAL_CONTEXT),
		uuidField(state.userId),
		integerField(state.version),
		integerField(state.sessionEpoch),
		state.email === null ? ABSENT_FIELD : textField(state.email),
		booleanField(state.emailVerified),
		booleanField(state.disabled),
		passwordField(state.password),
		booleanField(state.passwordResetRequired),
		totpField(state.totp),
		listField(
			state.passkeys.map((passkey) =>
				recordField([bytesField(passkey.credentialId), bytesField(passkey.publicKey)]),
			),
		),
		listField(
			state.identities.map((identity) =>
				recordField([textField(identity.provider), textField(identity.subject)]),
			),
		),
		listField(
			state.recoveryCodes.map((code) =>
				recordField([integerField(code.keyVersion), bytesField(code.codeHmac)]),
			),
		),
	]);
}
