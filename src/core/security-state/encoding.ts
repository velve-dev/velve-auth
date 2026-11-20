import type { OneTimeTokenPurpose } from "../token/purpose.js";

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
	/** the AAGUID of a passkey whose attestation chain verified, absent or null for every other passkey */
	readonly attestedAaguid?: string | null;
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

/** the new passkey a recovery holds back until its activation time, as the seal covers it */
interface SealedPasskeyRecovery {
	/** `activates_at` in whole microseconds since the Unix epoch */
	readonly activatesAtMicros: number;
	readonly credentialId: Uint8Array;
	readonly publicKey: Uint8Array;
	/** the AAGUID of a held back passkey whose attestation chain verified, absent or null otherwise */
	readonly attestedAaguid?: string | null;
}

/** every way into an account the seal covers, without the seal row's own version and epoch */
export interface SealedComponents {
	readonly email: string | null;
	readonly emailVerified: boolean;
	readonly disabled: boolean;
	/** whether every way into the account that does not use one of its own credentials is turned off */
	readonly recoveryDisabled: boolean;
	readonly password: SealedPassword | null;
	readonly passwordResetRequired: boolean;
	readonly totp: SealedTotp | null;
	readonly passkeys: readonly SealedPasskey[];
	readonly identities: readonly SealedIdentity[];
	readonly recoveryCodes: readonly SealedRecoveryCode[];
	/** the recovery to a new passkey that waits for its activation time, or null while none does */
	readonly passkeyRecovery: SealedPasskeyRecovery | null;
	/** the AAGUIDs a passkey must be attested as to sign the account in, absent or null while no list is set */
	readonly authenticatorAllowlist?: readonly string[] | null;
}

/** the token generation of each one-time token purpose, so a redemption leaves the links of the other purposes alone */
export type TokenGenerations = Readonly<Record<OneTimeTokenPurpose, number>>;

/** what a row written back with its old MAC is measured against, each moved by the use that spends such a row */
export interface SealedGenerations {
	/** the version of the last seal that changed a component or the epoch, which a session issue stands on */
	readonly componentsVersion: number;
	/** moved by every session revoked on its own */
	readonly sessionGeneration: number;
	/** moved by every booked second-factor attempt */
	readonly attemptGeneration: number;
	/** the token hash of the pending row whose booking moved it last */
	readonly attemptLast: Uint8Array | null;
	/** each moved by every redeemed one-time token of its purpose */
	readonly tokenGenerations: TokenGenerations;
	/** the token hash of the one-time token whose redemption moved it last */
	readonly tokenLast: Uint8Array | null;
}

/** the generations of an account no row has moved yet */
export const FIRST_GENERATIONS: SealedGenerations = {
	componentsVersion: 1,
	sessionGeneration: 1,
	attemptGeneration: 1,
	attemptLast: null,
	tokenGenerations: {
		email_verify: 1,
		password_reset: 1,
		email_change: 1,
		magic_link: 1,
		passkey_recovery: 1,
	},
	tokenLast: null,
};

/** the whole state one seal digest is taken over */
export interface SecurityState extends SealedComponents, SealedGenerations {
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

//an account that never turned recovery off keeps the encoding and so the seal it had before migration 6 (E-3731)
function recoveryDisabledField(recoveryDisabled: boolean): readonly Uint8Array[] {
	return recoveryDisabled ? [booleanField(true)] : [];
}

//the purposes of 2.0.0 keep their place so a seal taken before migration 7 still verifies (E-3763)
const PURPOSES_SEALED_IN_PLACE: readonly OneTimeTokenPurpose[] = [
	"email_verify",
	"password_reset",
	"email_change",
	"magic_link",
];

//a generation still at its first value is left out so an account no recovery link reached keeps its seal (E-3763)
function passkeyRecoveryGenerationField(generation: number): readonly Uint8Array[] {
	return generation === FIRST_GENERATIONS.tokenGenerations.passkey_recovery
		? []
		: [integerField(generation)];
}

//a passkey without a verified attestation keeps the record and so the seal it had before migration 8 (E-3846)
function attestedAaguidField(attestedAaguid: string | null | undefined): readonly Uint8Array[] {
	return attestedAaguid === null || attestedAaguid === undefined ? [] : [uuidField(attestedAaguid)];
}

function passkeyField(passkey: SealedPasskey): Uint8Array {
	return recordField([
		bytesField(passkey.credentialId),
		bytesField(passkey.publicKey),
		...attestedAaguidField(passkey.attestedAaguid),
	]);
}

function passkeyRecoveryField(recovery: SealedPasskeyRecovery | null): readonly Uint8Array[] {
	return recovery === null
		? []
		: [
				recordField([
					integerField(recovery.activatesAtMicros),
					bytesField(recovery.credentialId),
					bytesField(recovery.publicKey),
					...attestedAaguidField(recovery.attestedAaguid),
				]),
			];
}

//an account without a list keeps the encoding and so the seal it had before migration 8 (E-3846)
function authenticatorAllowlistField(
	allowlist: readonly string[] | null | undefined,
): readonly Uint8Array[] {
	return allowlist === null || allowlist === undefined ? [] : [listField(allowlist.map(uuidField))];
}

//no two different states may share an encoding (S-INTEG-2)
export function encodeSecurityState(state: SecurityState): Uint8Array<ArrayBuffer> {
	return concatenated([
		textField(SEAL_CONTEXT),
		uuidField(state.userId),
		integerField(state.version),
		integerField(state.sessionEpoch),
		integerField(state.componentsVersion),
		integerField(state.sessionGeneration),
		integerField(state.attemptGeneration),
		state.attemptLast === null ? ABSENT_FIELD : digestField(state.attemptLast),
		...PURPOSES_SEALED_IN_PLACE.map((purpose) => integerField(state.tokenGenerations[purpose])),
		state.tokenLast === null ? ABSENT_FIELD : digestField(state.tokenLast),
		state.email === null ? ABSENT_FIELD : textField(state.email),
		booleanField(state.emailVerified),
		booleanField(state.disabled),
		passwordField(state.password),
		booleanField(state.passwordResetRequired),
		totpField(state.totp),
		listField(state.passkeys.map(passkeyField)),
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
		...recoveryDisabledField(state.recoveryDisabled),
		...passkeyRecoveryGenerationField(state.tokenGenerations.passkey_recovery),
		...passkeyRecoveryField(state.passkeyRecovery),
		...authenticatorAllowlistField(state.authenticatorAllowlist),
	]);
}
