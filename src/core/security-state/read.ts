import { sha256 } from "@noble/hashes/sha2.js";
import type { Driver } from "../db/driver.js";
import { qualifiedTableName } from "../db/identifier.js";
import { isRowIdentifier } from "../db/row-identifier.js";
import type { KeyProvider } from "../keys/provider.js";
import type { SealedComponents, SealedGenerations, SecurityState } from "./encoding.js";
import { type SealVerdict, verifySeal } from "./seal.js";

/** whether every account must have a seal or the estate is still being sealed */
export type SealingMode = "required" | "migrating";

/** the seal row as it was read */
interface StoredSeal extends SealedGenerations {
	readonly version: number;
	readonly digest: Uint8Array<ArrayBuffer>;
	readonly keyVersion: number;
	readonly sessionEpoch: number;
}

/** a passkey as the one read returned it, the row a passkey path evaluates */
interface ReadPasskey {
	readonly id: string;
	readonly credentialId: Uint8Array<ArrayBuffer>;
	readonly publicKey: Uint8Array<ArrayBuffer>;
	readonly signCount: number;
}

/** an identity as the one read returned it, its stored provider tokens included for the envelope rewrite */
interface ReadIdentity {
	readonly id: string;
	readonly provider: string;
	readonly subject: string;
	readonly accessTokenEnc: Uint8Array<ArrayBuffer> | null;
	readonly refreshTokenEnc: Uint8Array<ArrayBuffer> | null;
	readonly idTokenEnc: Uint8Array<ArrayBuffer> | null;
	readonly tokenKeyVersion: number | null;
}

/** a recovery code as the one read returned it */
interface ReadRecoveryCode {
	readonly keyVersion: number;
	readonly codeHmac: Uint8Array<ArrayBuffer>;
}

/** the password credential as the one read returned it, ciphertext included */
interface ReadPassword {
	readonly phc: Uint8Array<ArrayBuffer>;
	readonly keyVersion: number;
	readonly scheme: string;
	readonly setBySessionId: string | null;
}

/** the TOTP secret as the one read returned it, ciphertext included */
interface ReadTotp {
	readonly secretEnc: Uint8Array<ArrayBuffer>;
	readonly keyVersion: number;
	readonly confirmed: boolean;
}

/** the seal row and every component of one account, all from a single statement */
export interface SecurityStateRead {
	readonly userId: string;
	readonly seal: StoredSeal | null;
	readonly email: string | null;
	readonly emailVerified: boolean;
	readonly disabled: boolean;
	readonly password: ReadPassword | null;
	readonly passwordResetRequired: boolean;
	readonly totp: ReadTotp | null;
	readonly passkeys: readonly ReadPasskey[];
	readonly identities: readonly ReadIdentity[];
	readonly recoveryCodes: readonly ReadRecoveryCode[];
}

/** what checking one read found, each failure named as the alarm names it */
export type SecurityStateVerdict = SealVerdict | "unsealed" | "seal_missing";

/** a verdict together with the read it was reached on, which is the only read a path may evaluate */
interface SecurityStateCheck {
	readonly verdict: SecurityStateVerdict;
	readonly read: SecurityStateRead;
}

//a statement that names an account reads its whole state in the same snapshot as everything else (E-3299)
export function securityStateDocumentOf(schema: string, accountIdSql: string): string {
	const table = (name: string) => qualifiedTableName(schema, name);
	return `(SELECT jsonb_build_object(
  'user_id', account.id::text,
  'email', account.email,
  'email_verified', account.email_verified_at IS NOT NULL,
  'disabled', account.disabled_at IS NOT NULL,
  'seal', CASE WHEN seal.user_id IS NULL THEN NULL ELSE jsonb_build_object(
    'version', seal.version::text,
    'digest', encode(seal.digest, 'hex'),
    'key_version', seal.key_version::text,
    'session_epoch', seal.session_epoch::text,
    'components_version', seal.components_version::text,
    'session_generation', seal.session_generation::text,
    'attempt_generation', seal.attempt_generation::text,
    'attempt_last', encode(seal.attempt_last, 'hex'),
    'email_verify_generation', seal.email_verify_generation::text,
    'password_reset_generation', seal.password_reset_generation::text,
    'email_change_generation', seal.email_change_generation::text,
    'magic_link_generation', seal.magic_link_generation::text,
    'token_last', encode(seal.token_last, 'hex')) END,
  'password', CASE WHEN credential.user_id IS NULL THEN NULL ELSE jsonb_build_object(
    'phc', encode(credential.phc, 'hex'),
    'key_version', credential.key_version::text,
    'scheme', credential.scheme,
    'set_by_session_id', credential.set_by_session_id::text) END,
  'password_reset_required', EXISTS (
    SELECT 1 FROM ${table("password_reset_required")} required WHERE required.user_id = account.id),
  'totp', CASE WHEN secret.user_id IS NULL THEN NULL ELSE jsonb_build_object(
    'secret_enc', encode(secret.secret_enc, 'hex'),
    'key_version', secret.key_version::text,
    'confirmed', secret.confirmed_at IS NOT NULL) END,
  'passkeys', (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', passkey.id::text,
      'credential_id', encode(passkey.credential_id, 'hex'),
      'public_key', encode(passkey.public_key, 'hex'),
      'sign_count', passkey.sign_count::text)), '[]'::jsonb)
    FROM ${table("webauthn_credential")} passkey WHERE passkey.user_id = account.id),
  'identities', (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', linked.id::text,
      'provider', linked.provider,
      'subject', linked.subject,
      'access_token_enc', encode(linked.access_token_enc, 'hex'),
      'refresh_token_enc', encode(linked.refresh_token_enc, 'hex'),
      'id_token_enc', encode(linked.id_token_enc, 'hex'),
      'token_key_version', linked.token_key_version::text)), '[]'::jsonb)
    FROM ${table("identity")} linked WHERE linked.user_id = account.id),
  'recovery_codes', (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'key_version', code.key_version::text,
      'code_hmac', encode(code.code_hmac, 'hex'))), '[]'::jsonb)
    FROM ${table("recovery_code")} code WHERE code.user_id = account.id)
)::text
FROM ${table("user")} account
LEFT JOIN ${table("security_state")} seal ON seal.user_id = account.id
LEFT JOIN ${table("password_credential")} credential ON credential.user_id = account.id
LEFT JOIN ${table("totp_credential")} secret ON secret.user_id = account.id
WHERE account.id = ${accountIdSql})`;
}

//one statement sees one consistent state under read committed, several could see a reseal between them (E-3280)
export function securityStateReadStatement(schema: string): string {
	return `SELECT ${securityStateDocumentOf(schema, "$1::uuid")} AS state`;
}

const HEX = /^(?:[0-9a-f]{2})*$/;
const DECIMAL = /^-?(0|[1-9][0-9]*)$/;

class UnreadableStateError extends Error {
	constructor(field: string) {
		super(`the state read returned a ${field} the library does not write`);
		this.name = "UnreadableStateError";
	}
}

function record(value: unknown, field: string): Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new UnreadableStateError(field);
	}
	return value as Readonly<Record<string, unknown>>;
}

function text(value: unknown, field: string): string {
	if (typeof value !== "string") {
		throw new UnreadableStateError(field);
	}
	return value;
}

function textOrNull(value: unknown, field: string): string | null {
	return value === null ? null : text(value, field);
}

function flag(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") {
		throw new UnreadableStateError(field);
	}
	return value;
}

function bytes(value: unknown, field: string): Uint8Array<ArrayBuffer> {
	const spelled = text(value, field);
	if (!HEX.test(spelled)) {
		throw new UnreadableStateError(field);
	}
	const decoded = new Uint8Array(spelled.length / 2);
	for (let index = 0; index < decoded.length; index += 1) {
		decoded[index] = Number.parseInt(spelled.slice(index * 2, index * 2 + 2), 16);
	}
	return decoded;
}

function bytesOrNull(value: unknown, field: string): Uint8Array<ArrayBuffer> | null {
	return value === null ? null : bytes(value, field);
}

//a stored integer beyond the exact javascript integers would be read as a number nobody stored
function exactInteger(value: unknown, field: string): number {
	const spelled = text(value, field);
	const parsed = Number(spelled);
	if (!DECIMAL.test(spelled) || !Number.isSafeInteger(parsed)) {
		throw new UnreadableStateError(field);
	}
	return parsed;
}

function list(value: unknown, field: string): readonly unknown[] {
	if (!Array.isArray(value)) {
		throw new UnreadableStateError(field);
	}
	return value;
}

function sealOf(value: unknown): StoredSeal | null {
	if (value === null) {
		return null;
	}
	const seal = record(value, "seal");
	return {
		version: exactInteger(seal.version, "seal version"),
		digest: bytes(seal.digest, "seal digest"),
		keyVersion: exactInteger(seal.key_version, "seal key version"),
		sessionEpoch: exactInteger(seal.session_epoch, "session epoch"),
		componentsVersion: exactInteger(seal.components_version, "components version"),
		sessionGeneration: exactInteger(seal.session_generation, "session generation"),
		attemptGeneration: exactInteger(seal.attempt_generation, "attempt generation"),
		attemptLast: bytesOrNull(seal.attempt_last, "attempt last"),
		tokenGenerations: {
			email_verify: exactInteger(seal.email_verify_generation, "token generation"),
			password_reset: exactInteger(seal.password_reset_generation, "token generation"),
			email_change: exactInteger(seal.email_change_generation, "token generation"),
			magic_link: exactInteger(seal.magic_link_generation, "token generation"),
		},
		tokenLast: bytesOrNull(seal.token_last, "token last"),
	};
}

function passwordOf(value: unknown): ReadPassword | null {
	if (value === null) {
		return null;
	}
	const password = record(value, "password");
	return {
		phc: bytes(password.phc, "password ciphertext"),
		keyVersion: exactInteger(password.key_version, "password key version"),
		scheme: text(password.scheme, "password scheme"),
		setBySessionId: textOrNull(password.set_by_session_id, "password session"),
	};
}

function totpOf(value: unknown): ReadTotp | null {
	if (value === null) {
		return null;
	}
	const totp = record(value, "totp");
	return {
		secretEnc: bytes(totp.secret_enc, "totp ciphertext"),
		keyVersion: exactInteger(totp.key_version, "totp key version"),
		confirmed: flag(totp.confirmed, "totp confirmation"),
	};
}

//a sign count past the exact integers is not sealed and is read as the largest one
function signCountOf(value: unknown): number {
	const spelled = text(value, "sign count");
	if (!DECIMAL.test(spelled)) {
		throw new UnreadableStateError("sign count");
	}
	return Math.min(Number(spelled), Number.MAX_SAFE_INTEGER);
}

function stateOf(spelled: string): SecurityStateRead {
	const state = record(JSON.parse(spelled), "state");
	return {
		userId: text(state.user_id, "account id"),
		seal: sealOf(state.seal),
		email: textOrNull(state.email, "address"),
		emailVerified: flag(state.email_verified, "address verification"),
		disabled: flag(state.disabled, "disabled state"),
		password: passwordOf(state.password),
		passwordResetRequired: flag(state.password_reset_required, "reset requirement"),
		totp: totpOf(state.totp),
		passkeys: list(state.passkeys, "passkeys").map((value) => {
			const passkey = record(value, "passkey");
			return {
				id: text(passkey.id, "passkey id"),
				credentialId: bytes(passkey.credential_id, "credential id"),
				publicKey: bytes(passkey.public_key, "public key"),
				signCount: signCountOf(passkey.sign_count),
			};
		}),
		identities: list(state.identities, "identities").map((value) => {
			const identity = record(value, "identity");
			return {
				id: text(identity.id, "identity id"),
				provider: text(identity.provider, "provider"),
				subject: text(identity.subject, "subject"),
				accessTokenEnc: bytesOrNull(identity.access_token_enc, "access token"),
				refreshTokenEnc: bytesOrNull(identity.refresh_token_enc, "refresh token"),
				idTokenEnc: bytesOrNull(identity.id_token_enc, "id token"),
				tokenKeyVersion:
					identity.token_key_version === null
						? null
						: exactInteger(identity.token_key_version, "token key version"),
			};
		}),
		recoveryCodes: list(state.recovery_codes, "recovery codes").map((value) => {
			const code = record(value, "recovery code");
			return {
				keyVersion: exactInteger(code.key_version, "recovery code key version"),
				codeHmac: bytes(code.code_hmac, "recovery code"),
			};
		}),
	};
}

export async function readSecurityState(
	driver: Driver,
	schema: string,
	userId: string,
): Promise<SecurityStateRead | null> {
	if (!isRowIdentifier(userId)) {
		return null;
	}
	const [row] = await driver.query<{ state: string | null }>(securityStateReadStatement(schema), [
		userId,
	]);
	return securityStateOfDocument(row?.state ?? null);
}

/** the read a statement's security-state document holds, or null for an account that does not exist */
export function securityStateOfDocument(document: string | null): SecurityStateRead | null {
	return document === null ? null : stateOf(document);
}

/** the components a read holds, with each ciphertext replaced by its SHA-256 value */
export function sealedComponentsOf(read: SecurityStateRead): SealedComponents {
	return {
		email: read.email,
		emailVerified: read.emailVerified,
		disabled: read.disabled,
		password:
			read.password === null
				? null
				: {
						phcSha256: sha256(read.password.phc),
						keyVersion: read.password.keyVersion,
						setBySessionId: read.password.setBySessionId,
					},
		passwordResetRequired: read.passwordResetRequired,
		totp:
			read.totp === null
				? null
				: {
						confirmed: read.totp.confirmed,
						secretSha256: sha256(read.totp.secretEnc),
						keyVersion: read.totp.keyVersion,
					},
		passkeys: read.passkeys.map(({ credentialId, publicKey }) => ({ credentialId, publicKey })),
		identities: read.identities.map(({ provider, subject }) => ({ provider, subject })),
		recoveryCodes: read.recoveryCodes.map(({ keyVersion, codeHmac }) => ({ keyVersion, codeHmac })),
	};
}

/** the state a stored seal was taken over, as the read reconstructs it */
export function securityStateOf(read: SecurityStateRead, seal: StoredSeal): SecurityState {
	return {
		userId: read.userId,
		version: seal.version,
		sessionEpoch: seal.sessionEpoch,
		...generationsOf(seal),
		...sealedComponentsOf(read),
	};
}

/** the generations a seal row holds */
export function generationsOf(seal: SealedGenerations): SealedGenerations {
	return {
		componentsVersion: seal.componentsVersion,
		sessionGeneration: seal.sessionGeneration,
		attemptGeneration: seal.attemptGeneration,
		attemptLast: seal.attemptLast,
		tokenGenerations: seal.tokenGenerations,
		tokenLast: seal.tokenLast,
	};
}

//a missing seal row is broken only where every account must be sealed (E-3083)
export async function checkSecurityState(
	keys: KeyProvider,
	read: SecurityStateRead,
	sealing: SealingMode,
): Promise<SecurityStateCheck> {
	if (read.seal === null) {
		return { verdict: sealing === "required" ? "seal_missing" : "unsealed", read };
	}
	const verdict = await verifySeal(keys, securityStateOf(read, read.seal), {
		keyVersion: read.seal.keyVersion,
		digest: read.seal.digest,
	});
	return { verdict, read };
}
