import type { Identity } from "../auth/results.js";
import type { Actor } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { assertSchemaName, qualifiedTableName } from "../db/identifier.js";

/** The three columns S-REST-4 names, written only when `storeTokens` says so (S-REST-6). */
export interface EncryptedProviderTokens {
	readonly accessTokenEnc: Uint8Array<ArrayBuffer> | null;
	readonly refreshTokenEnc: Uint8Array<ArrayBuffer> | null;
	readonly idTokenEnc: Uint8Array<ArrayBuffer> | null;
	readonly tokenKeyVersion: number | null;
}

export const NO_STORED_TOKENS: EncryptedProviderTokens = {
	accessTokenEnc: null,
	refreshTokenEnc: null,
	idTokenEnc: null,
	tokenKeyVersion: null,
};

export interface IdentityFacts {
	readonly provider: string;
	readonly subject: string;
	readonly providerEmail: string | null;
	readonly providerEmailVerified: boolean;
	readonly profile: unknown;
	readonly scopes: readonly string[];
	readonly tokenLifetimeInSeconds: number | null;
	readonly tokens: EncryptedProviderTokens;
}

export interface OwnedIdentity {
	readonly identity: Identity;
	readonly userId: string;
}

export interface OAuthIdentityRepository {
	/** S-LINK-1: `(provider, subject)` is the whole predicate, and no other query reaches an identity by address. */
	findIdentityBySubject(input: {
		readonly provider: string;
		readonly subject: string;
	}): Promise<OwnedIdentity | null>;
	/** Null means the pair is already linked — to this account or to another (E-989). */
	insertIdentity(input: { readonly userId: string } & IdentityFacts): Promise<Identity | null>;
	/** S-LINK-6: the provider's verification state is written per identity on every sign-in. */
	refreshIdentity(input: IdentityFacts): Promise<Identity>;
	listIdentitiesOwnedBy(input: { readonly actor: Actor }): Promise<Identity[]>;
}

interface IdentityRow {
	readonly id: string;
	readonly user_id: string;
	readonly provider: string;
	readonly subject: string;
	readonly provider_email: string | null;
	readonly provider_email_verified: boolean;
	readonly profile: unknown;
	readonly scopes: string | null;
	readonly token_expires_at: unknown;
	readonly created_at: unknown;
}

function toDate(value: unknown): Date {
	if (value instanceof Date) {
		return value;
	}
	throw new TypeError("the driver must decode timestamptz into a Date");
}

function toOptionalDate(value: unknown): Date | null {
	return value === null || value === undefined ? null : toDate(value);
}

/** A driver hands `jsonb` back decoded or as the text PostgreSQL sent, and both arrive here. */
function readProfile(value: unknown): unknown {
	if (typeof value !== "string") {
		return value ?? null;
	}
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function readScopes(value: string | null): readonly string[] {
	return value === null || value === "" ? [] : value.split(" ");
}

function toIdentity(row: IdentityRow): Identity {
	return {
		id: row.id,
		provider: row.provider,
		subject: row.subject,
		createdAt: toDate(row.created_at),
		providerEmail: row.provider_email,
		providerEmailVerified: row.provider_email_verified,
		profile: readProfile(row.profile),
		scopes: readScopes(row.scopes),
		tokenExpiresAt: toOptionalDate(row.token_expires_at),
	};
}

function factParameters(facts: IdentityFacts): readonly unknown[] {
	return [
		facts.providerEmail,
		facts.providerEmailVerified,
		facts.profile === null || facts.profile === undefined ? null : JSON.stringify(facts.profile),
		facts.scopes.join(" "),
		facts.tokens.accessTokenEnc,
		facts.tokens.refreshTokenEnc,
		facts.tokens.idTokenEnc,
		facts.tokens.tokenKeyVersion,
		facts.tokenLifetimeInSeconds,
	];
}

export function createOAuthIdentityRepository(options: {
	readonly driver: Driver;
	readonly schema: string;
}): OAuthIdentityRepository {
	const schema = assertSchemaName(options.schema);
	const identities = qualifiedTableName(schema, "identity");

	/* 3.15 C.2: the three token columns and the key version never leave the database, so no
	   statement here selects them. */
	const RETURNED_COLUMNS = `id, user_id, provider, subject, provider_email, provider_email_verified,
profile, array_to_string(scopes, ' ') AS scopes, token_expires_at, created_at`;

	const findStatement = `SELECT ${RETURNED_COLUMNS} FROM ${identities}
/* no owner predicate: S-LINK-1, this lookup is what decides which account the identity belongs to */
WHERE provider = $1 AND subject = $2`;

	const insertStatement = `INSERT INTO ${identities}
(user_id, provider, subject, provider_email, provider_email_verified, profile, scopes,
 access_token_enc, refresh_token_enc, id_token_enc, token_key_version, token_expires_at)
VALUES ($1, $2, $3, $4, $5, $6::jsonb, string_to_array($7::text, ' '), $8, $9, $10, $11,
        now() + make_interval(secs => $12::double precision))
ON CONFLICT (provider, subject) DO NOTHING
RETURNING ${RETURNED_COLUMNS}`;

	const refreshStatement = `UPDATE ${identities}
/* no owner predicate: S-LINK-1, the row is addressed by the pair that identifies it and the
   account it names is the answer rather than the question */
SET provider_email = $3, provider_email_verified = $4, profile = $5::jsonb,
    scopes = string_to_array($6::text, ' '),
    access_token_enc = $7, refresh_token_enc = $8, id_token_enc = $9, token_key_version = $10,
    token_expires_at = now() + make_interval(secs => $11::double precision),
    updated_at = now()
WHERE provider = $1 AND subject = $2
RETURNING ${RETURNED_COLUMNS}`;

	const listStatement = `SELECT ${RETURNED_COLUMNS} FROM ${identities}
WHERE user_id = $1 ORDER BY created_at, id`;

	return {
		async findIdentityBySubject({ provider, subject }) {
			const [row] = await options.driver.query<IdentityRow>(findStatement, [provider, subject]);
			return row === undefined ? null : { identity: toIdentity(row), userId: row.user_id };
		},

		async insertIdentity({ userId, provider, subject, ...facts }) {
			const [row] = await options.driver.query<IdentityRow>(insertStatement, [
				userId,
				provider,
				subject,
				...factParameters({ provider, subject, ...facts }),
			]);
			return row === undefined ? null : toIdentity(row);
		},

		async refreshIdentity({ provider, subject, ...facts }) {
			const [row] = await options.driver.query<IdentityRow>(refreshStatement, [
				provider,
				subject,
				...factParameters({ provider, subject, ...facts }),
			]);
			if (row === undefined) {
				throw new TypeError("the identity refreshed by its own subject reported no row");
			}
			return toIdentity(row);
		},

		async listIdentitiesOwnedBy({ actor }) {
			const rows = await options.driver.query<IdentityRow>(listStatement, [actor]);
			return rows.map(toIdentity);
		},
	};
}
