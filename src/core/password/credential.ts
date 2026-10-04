import type { Actor } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { qualifiedTableName } from "../db/identifier.js";
import {
	decryptWithPurposeKey,
	type EncryptionKeyPurpose,
	encryptWithPurposeKey,
	type KeyProvider,
} from "../keys/index.js";
import { CredentialWriteError } from "./errors.js";
import { type PasswordScheme, schemeOfStoredHash } from "./scheme.js";
import { credentialReachesDerivation } from "./verify-switch.js";

export const PASSWORD_ENC_PURPOSE: EncryptionKeyPurpose = "password-enc";
export const PASSWORD_CREDENTIAL_SCHEMA = "velve";
export const PASSWORD_CREDENTIAL_TABLE = "password_credential";

const utf8 = new TextEncoder();

export interface PasswordCredentialRow {
	readonly userId: string;
	//the column holds the encrypted PHC string and never the string itself (S-REST-5)
	readonly phc: Uint8Array<ArrayBuffer>;
	readonly keyVersion: number;
	//the scheme stays cleartext for a PHC estate to be surveyed without a key
	readonly scheme: PasswordScheme;
}

export interface SealedPhc {
	readonly keyVersion: number;
	readonly ciphertext: Uint8Array<ArrayBuffer>;
}

//this is the only place a PHC string becomes a column value
export function sealPhc(keys: KeyProvider, phc: string): Promise<SealedPhc> {
	return encryptWithPurposeKey(keys, PASSWORD_ENC_PURPOSE, utf8.encode(phc));
}

export async function openPhc(keys: KeyProvider, row: PasswordCredentialRow): Promise<string> {
	return new TextDecoder().decode(
		await decryptWithPurposeKey(keys, PASSWORD_ENC_PURPOSE, row.keyVersion, row.phc),
	);
}

interface PasswordCredentialWrite {
	phc: string;
	scheme: PasswordScheme;
	//setBySessionId is never defaulted or a later first confirmation drops the password (E-626)
	setBySessionId: string | null;
}

export interface PasswordCredentialRepository {
	//a sign-in has no proof yet as the row read here is what the proof is made from (E-2423)
	findByUserId(userId: string): Promise<PasswordCredentialRow | null>;
	findOwnedBy(input: { readonly actor: Actor }): Promise<PasswordCredentialRow | null>;
	write(input: { actor: Actor } & PasswordCredentialWrite): Promise<void>;
	//the account row was inserted by the same transaction so no other caller can own it (E-2428)
	writeForCreatedAccount(input: { userId: string } & PasswordCredentialWrite): Promise<void>;
	replaceIfUnchanged(input: {
		userId: string;
		previous: Uint8Array<ArrayBuffer>;
		phc: string;
		scheme: PasswordScheme;
	}): Promise<boolean>;
}

interface RawRow {
	readonly user_id: string;
	readonly phc: Uint8Array<ArrayBuffer>;
	readonly key_version: number;
	readonly scheme: PasswordScheme;
}

export interface PasswordCredentialRepositoryOptions {
	readonly driver: Driver;
	readonly keys: KeyProvider;
	readonly schema?: string;
	readonly memoryCeilingKiB: number;
}

function assertSchemeMatchesCredential(phc: string, scheme: PasswordScheme): void {
	if (schemeOfStoredHash(phc) !== scheme) {
		throw new CredentialWriteError("scheme_does_not_match_credential");
	}
}

//a credential every sign-in would refuse is never stored (E-2616)
function assertCredentialIsVerifiable(
	phc: string,
	scheme: PasswordScheme,
	memoryCeilingKiB: number,
): void {
	assertSchemeMatchesCredential(phc, scheme);
	if (!credentialReachesDerivation(scheme, phc, memoryCeilingKiB)) {
		throw new CredentialWriteError("credential_not_verifiable");
	}
}

export function createPasswordCredentialRepository(
	options: PasswordCredentialRepositoryOptions,
): PasswordCredentialRepository {
	const table = qualifiedTableName(
		options.schema ?? PASSWORD_CREDENTIAL_SCHEMA,
		PASSWORD_CREDENTIAL_TABLE,
	);
	const { memoryCeilingKiB } = options;

	async function findOne(ownerId: string): Promise<PasswordCredentialRow | null> {
		const [row] = await options.driver.query<RawRow>(
			`SELECT user_id, phc, key_version, scheme FROM ${table} WHERE user_id = $1`,
			[ownerId],
		);

		return row === undefined
			? null
			: {
					userId: row.user_id,
					phc: row.phc,
					keyVersion: row.key_version,
					scheme: row.scheme,
				};
	}

	async function sealedRow(
		ownerId: string,
		{ phc, scheme, setBySessionId }: PasswordCredentialWrite,
	): Promise<unknown[]> {
		assertCredentialIsVerifiable(phc, scheme, memoryCeilingKiB);
		const sealed = await sealPhc(options.keys, phc);
		return [ownerId, sealed.ciphertext, sealed.keyVersion, scheme, setBySessionId];
	}

	//a false conflict predicate writes nothing and must not be reported as stored (E-185)
	function assertWritten(written: readonly unknown[]): void {
		if (written.length !== 1) {
			throw new CredentialWriteError("credential_not_written");
		}
	}

	async function writeOwnedBy(ownerId: string, credential: PasswordCredentialWrite): Promise<void> {
		//the conflict is on the owner column and the predicate says so explicitly (S-OWNER-2)
		const written = await options.driver.query(
			`INSERT INTO ${table} AS credential (user_id, phc, key_version, scheme, set_by_session_id)
			 VALUES ($1, $2, $3, $4, $5)
			 ON CONFLICT (user_id) DO UPDATE
			 SET phc = EXCLUDED.phc, key_version = EXCLUDED.key_version,
			     scheme = EXCLUDED.scheme, set_by_session_id = EXCLUDED.set_by_session_id,
			     updated_at = now()
			 WHERE credential.user_id = $1
			 RETURNING user_id`,
			await sealedRow(ownerId, credential),
		);
		assertWritten(written);
	}

	//without a proof only a first credential may be written so an existing one is a key violation (E-2428)
	async function insertFirst(ownerId: string, credential: PasswordCredentialWrite): Promise<void> {
		const written = await options.driver.query(
			`INSERT INTO ${table} (user_id, phc, key_version, scheme, set_by_session_id)
			 VALUES ($1, $2, $3, $4, $5)
			 RETURNING user_id`,
			await sealedRow(ownerId, credential),
		);
		assertWritten(written);
	}

	return {
		findByUserId: findOne,

		findOwnedBy: ({ actor }) => findOne(actor),

		write: ({ actor, ...credential }) => writeOwnedBy(actor, credential),

		writeForCreatedAccount: ({ userId, ...credential }) => insertFirst(userId, credential),

		//compare and swap keeps a rehash from overwriting a password changed meanwhile (E-11)
		async replaceIfUnchanged({ userId, previous, phc, scheme }) {
			assertCredentialIsVerifiable(phc, scheme, memoryCeilingKiB);
			const sealed = await sealPhc(options.keys, phc);

			const changed = await options.driver.query(
				`UPDATE ${table}
				 SET phc = $2, scheme = $3, key_version = $4, updated_at = now()
				 WHERE user_id = $1 AND phc = $5
				 RETURNING user_id`,
				[userId, sealed.ciphertext, scheme, sealed.keyVersion, previous],
			);

			return changed.length === 1;
		},
	};
}
