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

export const PASSWORD_ENC_PURPOSE: EncryptionKeyPurpose = "password-enc";
export const PASSWORD_CREDENTIAL_SCHEMA = "velve";
export const PASSWORD_CREDENTIAL_TABLE = "password_credential";

const utf8 = new TextEncoder();

export interface PasswordCredentialRow {
	readonly userId: string;
	/** AES-256-GCM over the canonical PHC string, never the string itself (L-2, S-REST-5). */
	readonly phc: Uint8Array<ArrayBuffer>;
	readonly keyVersion: number;
	/** Cleartext, so the estate can be surveyed without a key (L-2). */
	readonly scheme: PasswordScheme;
}

export interface SealedPhc {
	readonly keyVersion: number;
	readonly ciphertext: Uint8Array<ArrayBuffer>;
}

/** The one place a PHC string turns into what the column holds; there is no other write path. */
export function sealPhc(keys: KeyProvider, phc: string): Promise<SealedPhc> {
	return encryptWithPurposeKey(keys, PASSWORD_ENC_PURPOSE, utf8.encode(phc));
}

export async function openPhc(keys: KeyProvider, row: PasswordCredentialRow): Promise<string> {
	return new TextDecoder().decode(
		await decryptWithPurposeKey(keys, PASSWORD_ENC_PURPOSE, row.keyVersion, row.phc),
	);
}

export interface PasswordCredentialRepository {
	findByUserId(userId: string): Promise<PasswordCredentialRow | null>;
	write(input: { userId: string; phc: string; scheme: PasswordScheme }): Promise<void>;
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
}

function assertSchemeMatchesCredential(phc: string, scheme: PasswordScheme): void {
	if (schemeOfStoredHash(phc) !== scheme) {
		throw new CredentialWriteError("scheme_does_not_match_credential");
	}
}

export function createPasswordCredentialRepository(
	options: PasswordCredentialRepositoryOptions,
): PasswordCredentialRepository {
	const table = qualifiedTableName(
		options.schema ?? PASSWORD_CREDENTIAL_SCHEMA,
		PASSWORD_CREDENTIAL_TABLE,
	);

	return {
		async findByUserId(userId) {
			const [row] = await options.driver.query<RawRow>(
				`SELECT user_id, phc, key_version, scheme FROM ${table} WHERE user_id = $1`,
				[userId],
			);

			return row === undefined
				? null
				: {
						userId: row.user_id,
						phc: row.phc,
						keyVersion: row.key_version,
						scheme: row.scheme,
					};
		},

		async write({ userId, phc, scheme }) {
			assertSchemeMatchesCredential(phc, scheme);
			const sealed = await sealPhc(options.keys, phc);

			// S-OWNER-2: the conflict target is the owner column, and the predicate says so in the
			// statement rather than leaving it to be inferred from the primary key (E-185).
			const written = await options.driver.query(
				`INSERT INTO ${table} AS credential (user_id, phc, key_version, scheme)
				 VALUES ($1, $2, $3, $4)
				 ON CONFLICT (user_id) DO UPDATE
				 SET phc = EXCLUDED.phc, key_version = EXCLUDED.key_version,
				     scheme = EXCLUDED.scheme, updated_at = now()
				 WHERE credential.user_id = $1
				 RETURNING user_id`,
				[userId, sealed.ciphertext, sealed.keyVersion, scheme],
			);

			// A conflict predicate that is false does not raise, it updates nothing; without this
			// the caller is told the password was stored when it was not (E-185).
			if (written.length !== 1) {
				throw new CredentialWriteError("credential_not_written");
			}
		},

		// 3.3 step 6: compare and swap on the stored ciphertext, so a password the user changed
		// while the rehash was running is never overwritten by it (E-11).
		async replaceIfUnchanged({ userId, previous, phc, scheme }) {
			assertSchemeMatchesCredential(phc, scheme);
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
