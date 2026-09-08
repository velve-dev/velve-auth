import type { Actor } from "../../db/actor.js";
import type { Driver } from "../../db/driver.js";
import { qualifiedTableName } from "../../db/identifier.js";
import type { PendingResolution } from "../pending/index.js";

/**
 * Who a credential belongs to, proved in one of the two ways this library recognises: a resolved
 * session, or the intermediate state a correct password produced. A `PendingResolution` mints no
 * `Actor` on purpose (3.15 B.7, S-FIX-4), and a second factor still has to reach the account's
 * own rows — so the owner predicate takes either proof and never a bare string (E-459).
 */
export type CredentialOwner = Actor | PendingResolution;

export function ownerIdOf(owner: CredentialOwner): string {
	return typeof owner === "string" ? owner : owner.userId;
}

/** Architecture 3.15 C. `credential_id`, `public_key` and `sign_count` are absent by decision
 * (3.15 C.2); the identifier a caller names a credential by is the row's own uuid. */
export interface WebAuthnCredential {
	readonly id: string;
	readonly label: string;
	readonly transports: readonly string[];
	readonly aaguid: string | null;
	readonly isBackupEligible: boolean;
	readonly isCurrentlyBackedUp: boolean;
	readonly wasUserVerifiedAtRegistration: boolean;
	readonly createdAt: Date;
	readonly lastUsedAt: Date | null;
}

export interface StoredWebAuthnCredential {
	readonly id: string;
	readonly userId: string;
	readonly credentialId: Uint8Array<ArrayBuffer>;
	readonly publicKey: Uint8Array<ArrayBuffer>;
	readonly signCount: number;
	readonly transports: readonly string[];
	readonly presented: WebAuthnCredential;
}

export interface WebAuthnCredentialInsert {
	readonly actor: Actor;
	readonly credentialId: Uint8Array<ArrayBuffer>;
	readonly publicKey: Uint8Array<ArrayBuffer>;
	readonly signCount: number;
	readonly transports: readonly string[];
	readonly aaguid: string | null;
	readonly isBackupEligible: boolean;
	readonly isCurrentlyBackedUp: boolean;
	readonly wasUserVerifiedAtRegistration: boolean;
	readonly label: string;
}

export interface WebAuthnAssertionRecord {
	readonly verified: StoredWebAuthnCredential;
	readonly signCount: number;
	readonly isBackupEligible: boolean;
	readonly isCurrentlyBackedUp: boolean;
}

export interface WebAuthnCredentialRepository {
	insertCredential(input: WebAuthnCredentialInsert): Promise<WebAuthnCredential>;
	listCredentialsOwnedBy(input: { actor: Actor }): Promise<WebAuthnCredential[]>;
	listDescriptorsOwnedBy(input: { owner: CredentialOwner }): Promise<StoredWebAuthnCredential[]>;
	/** S-OWNER-1 exception, on E-242's rule: the caller reaches this row through a signature it
	 * has not yet checked and has no actor to offer, because discoverable sign-in names no user. */
	findCredentialByCredentialId(input: {
		credentialId: Uint8Array<ArrayBuffer>;
	}): Promise<StoredWebAuthnCredential | null>;
	findOwnedCredentialByCredentialId(input: {
		credentialId: Uint8Array<ArrayBuffer>;
		owner: CredentialOwner;
	}): Promise<StoredWebAuthnCredential | null>;
	renameCredential(input: {
		id: string;
		actor: Actor;
		label: string;
	}): Promise<WebAuthnCredential | null>;
	/** The same exception: the row it writes is the row it was handed, already read and verified. */
	recordAssertion(input: WebAuthnAssertionRecord): Promise<WebAuthnCredential | null>;
}

export class DuplicateWebAuthnCredentialError extends Error {
	readonly code = "webauthn_credential_already_registered";

	constructor() {
		super("The authenticator is already registered.");
		this.name = "DuplicateWebAuthnCredentialError";
	}
}

const UNIQUE_VIOLATION = "23505";

interface CredentialRow {
	readonly id: string;
	readonly user_id: string;
	readonly credential_id: unknown;
	readonly public_key: unknown;
	readonly sign_count: unknown;
	readonly transports: string | null;
	readonly aaguid: string | null;
	readonly backup_eligible: boolean;
	readonly backup_state: boolean;
	readonly user_verified_at_registration: boolean;
	readonly label: string | null;
	readonly created_at: unknown;
	readonly last_used_at: unknown;
}

/** A transport is whatever the browser called it (E-453), so it may not travel through a
 * delimiter: `["a,b"]` and `["a","b"]` would arrive as the same two entries. */
function readTransports(value: string | null): readonly string[] {
	if (value === null) {
		return [];
	}
	const parsed: unknown = JSON.parse(value);
	if (!Array.isArray(parsed)) {
		return [];
	}
	return parsed.filter((entry): entry is string => typeof entry === "string");
}

function readBytes(value: unknown): Uint8Array<ArrayBuffer> {
	if (value instanceof Uint8Array) {
		return Uint8Array.from(value);
	}
	throw new TypeError("the driver did not hand back a bytea column as bytes");
}

function readDate(value: unknown): Date {
	if (value instanceof Date) {
		return value;
	}
	throw new TypeError("the driver did not hand back a timestamptz column as a date");
}

function readOptionalDate(value: unknown): Date | null {
	return value === null || value === undefined ? null : readDate(value);
}

function readCount(value: unknown): number {
	return typeof value === "number" ? value : Number(value);
}

/** An imported credential carries no label (architecture 4.1 e), and the surface promises a
 * string; the empty one is what "the import knew no name" looks like. */
function presentedCredential(row: CredentialRow): WebAuthnCredential {
	return {
		id: row.id,
		label: row.label ?? "",
		transports: readTransports(row.transports),
		aaguid: row.aaguid,
		isBackupEligible: row.backup_eligible,
		isCurrentlyBackedUp: row.backup_state,
		wasUserVerifiedAtRegistration: row.user_verified_at_registration,
		createdAt: readDate(row.created_at),
		lastUsedAt: readOptionalDate(row.last_used_at),
	};
}

function storedCredential(row: CredentialRow): StoredWebAuthnCredential {
	return {
		id: row.id,
		userId: row.user_id,
		credentialId: readBytes(row.credential_id),
		publicKey: readBytes(row.public_key),
		signCount: readCount(row.sign_count),
		transports: readTransports(row.transports),
		presented: presentedCredential(row),
	};
}

/** `pg` and `postgres.js` name it `code`, the test connection names it `sqlState`; both are the
 * five characters PostgreSQL sent. */
function isUniqueViolation(cause: unknown): boolean {
	if (typeof cause !== "object" || cause === null) {
		return false;
	}
	const fields = cause as { readonly code?: unknown; readonly sqlState?: unknown };
	return fields.code === UNIQUE_VIOLATION || fields.sqlState === UNIQUE_VIOLATION;
}

export function createWebAuthnCredentialRepository(options: {
	readonly driver: Driver;
	readonly schema: string;
}): WebAuthnCredentialRepository {
	const table = qualifiedTableName(options.schema, "webauthn_credential");

	const SELECTED_COLUMNS = `id, user_id, credential_id, public_key, sign_count,
	to_jsonb(coalesce(transports, '{}'))::text AS transports, aaguid::text AS aaguid,
	backup_eligible, backup_state, user_verified_at_registration, label,
	created_at, last_used_at`;

	const insertStatement = `INSERT INTO ${table}
	(user_id, credential_id, public_key, sign_count, transports, aaguid,
	 backup_eligible, backup_state, user_verified_at_registration, label)
VALUES ($1, $2, $3, $4, ARRAY(SELECT jsonb_array_elements_text($5::jsonb)), $6::uuid,
	$7, $8, $9, $10)
RETURNING ${SELECTED_COLUMNS}`;

	/* S-OWNER-2: the owner stands in the predicate, so a row belonging to somebody else is not a
	   row these statements can reach. */
	const listStatement = `SELECT ${SELECTED_COLUMNS} FROM ${table}
WHERE user_id = $1 ORDER BY created_at, id`;

	const findByCredentialIdStatement = `SELECT ${SELECTED_COLUMNS} FROM ${table}
WHERE credential_id = $1`;

	const findOwnedByCredentialIdStatement = `SELECT ${SELECTED_COLUMNS} FROM ${table}
WHERE credential_id = $1 AND user_id = $2`;

	const renameStatement = `UPDATE ${table} SET label = $3
WHERE id = $1::uuid AND user_id = $2
RETURNING ${SELECTED_COLUMNS}`;

	/* Architecture 3.6: the backup flags come from the authenticator on every sign-in, so a
	   passkey that has since been synchronised stops reading as device-bound. */
	const recordAssertionStatement = `UPDATE ${table}
SET sign_count = $3, backup_eligible = $4, backup_state = $5, last_used_at = now()
WHERE id = $1::uuid AND user_id = $2
RETURNING ${SELECTED_COLUMNS}`;

	async function single(sql: string, params: unknown[]): Promise<CredentialRow | null> {
		const [row] = await options.driver.query<CredentialRow>(sql, params);
		return row ?? null;
	}

	return {
		async insertCredential(input) {
			const row = await single(insertStatement, [
				input.actor,
				input.credentialId,
				input.publicKey,
				input.signCount,
				JSON.stringify(input.transports),
				input.aaguid,
				input.isBackupEligible,
				input.isCurrentlyBackedUp,
				input.wasUserVerifiedAtRegistration,
				input.label,
			]).catch((cause: unknown) => {
				if (isUniqueViolation(cause)) {
					throw new DuplicateWebAuthnCredentialError();
				}
				throw cause;
			});
			if (row === null) {
				throw new Error("the insert of a webauthn credential reported no row");
			}
			return presentedCredential(row);
		},

		async listCredentialsOwnedBy({ actor }) {
			const rows = await options.driver.query<CredentialRow>(listStatement, [actor]);
			return rows.map(presentedCredential);
		},

		async listDescriptorsOwnedBy({ owner }) {
			const rows = await options.driver.query<CredentialRow>(listStatement, [ownerIdOf(owner)]);
			return rows.map(storedCredential);
		},

		async findCredentialByCredentialId({ credentialId }) {
			const row = await single(findByCredentialIdStatement, [credentialId]);
			return row === null ? null : storedCredential(row);
		},

		async findOwnedCredentialByCredentialId({ credentialId, owner }) {
			const row = await single(findOwnedByCredentialIdStatement, [credentialId, ownerIdOf(owner)]);
			return row === null ? null : storedCredential(row);
		},

		async renameCredential({ id, actor, label }) {
			const row = await single(renameStatement, [id, actor, label]);
			return row === null ? null : presentedCredential(row);
		},

		async recordAssertion({ verified, signCount, isBackupEligible, isCurrentlyBackedUp }) {
			const row = await single(recordAssertionStatement, [
				verified.id,
				verified.userId,
				signCount,
				isBackupEligible,
				isCurrentlyBackedUp,
			]);
			return row === null ? null : presentedCredential(row);
		},
	};
}
