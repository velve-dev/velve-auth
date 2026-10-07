import type { Identity } from "../auth/results.js";
import type { Actor } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { assertSchemaName, qualifiedTableName } from "../db/identifier.js";
import { ConcealedError, VelveError } from "../http/error-map.js";
import {
	type BoundColumn,
	encryptBound,
	type RebindOutcome,
	rebindEnvelope,
	type UnboundEnvelopeReading,
} from "../keys/envelope-binding.js";
import { KeyError } from "../keys/errors.js";
import type { KeyProvider } from "../keys/provider.js";
import { randomUuid } from "../token/random.js";
import type { ProviderTokens } from "./token-exchange.js";

/** the three provider tokens an identity row can store, before they are encrypted */
type ProviderTokensToStore = Pick<ProviderTokens, "accessToken" | "refreshToken" | "idToken">;

interface EncryptedProviderTokens {
	readonly accessTokenEnc: Uint8Array<ArrayBuffer> | null;
	readonly refreshTokenEnc: Uint8Array<ArrayBuffer> | null;
	readonly idTokenEnc: Uint8Array<ArrayBuffer> | null;
	readonly tokenKeyVersion: number | null;
}

const NO_STORED_TOKENS: EncryptedProviderTokens = {
	accessTokenEnc: null,
	refreshTokenEnc: null,
	idTokenEnc: null,
	tokenKeyVersion: null,
};

const utf8 = new TextEncoder();

//no one of the three tokens may open in the column of another (S-INTEG-1)
async function encryptedProviderTokens(
	keys: KeyProvider,
	row: { readonly owner: string; readonly identityId: string },
	tokens: ProviderTokensToStore | null,
): Promise<EncryptedProviderTokens> {
	if (tokens === null) {
		return NO_STORED_TOKENS;
	}
	const columns: readonly (readonly [BoundColumn, string | null])[] = [
		["identity.access_token_enc", tokens.accessToken],
		["identity.refresh_token_enc", tokens.refreshToken],
		["identity.id_token_enc", tokens.idToken],
	];
	const sealed = await Promise.all(
		columns.map(([column, token]) =>
			token === null
				? null
				: encryptBound(keys, { column, owner: row.owner, row: row.identityId }, utf8.encode(token)),
		),
	);
	const versions = new Set(
		sealed.filter((written) => written !== null).map((written) => written.keyVersion),
	);
	//the three ciphertexts of a row must share the one key version the row stores
	if (versions.size > 1) {
		throw new VelveError("internal_error");
	}
	return {
		accessTokenEnc: sealed[0]?.ciphertext ?? null,
		refreshTokenEnc: sealed[1]?.ciphertext ?? null,
		idTokenEnc: sealed[2]?.ciphertext ?? null,
		tokenKeyVersion: [...versions][0] ?? null,
	};
}

export interface IdentityFacts {
	readonly provider: string;
	readonly subject: string;
	readonly providerEmail: string | null;
	readonly providerEmailVerified: boolean;
	readonly profile: unknown;
	readonly scopes: readonly string[];
	readonly tokenLifetimeInSeconds: number | null;
	/** the tokens to store encrypted, or null when storeTokens is off */
	readonly tokens: ProviderTokensToStore | null;
}

interface OwnedIdentity {
	readonly identity: Identity;
	readonly userId: string;
}

interface OAuthIdentityRepository {
	//provider and subject are the whole predicate, no query finds an identity by address (S-LINK-1)
	findIdentityBySubject(input: {
		readonly provider: string;
		readonly subject: string;
	}): Promise<OwnedIdentity | null>;
	//null means the pair is already linked, to this account or to another (E-989)
	insertIdentity(input: { readonly actor: Actor } & IdentityFacts): Promise<Identity | null>;
	//a sign-in binds the account it created or automatic linking joined and holds no proof (E-2434)
	insertIdentityOfSignIn(
		input: { readonly userId: string } & IdentityFacts,
	): Promise<Identity | null>;
	//the provider's verification state is written per identity on every sign-in (S-LINK-6)
	refreshIdentity(input: { readonly existing: OwnedIdentity } & IdentityFacts): Promise<Identity>;
	listIdentitiesOwnedBy(input: { readonly actor: Actor }): Promise<Identity[]>;
	//the stored tokens are opened and re-encrypted and never fetched again from the provider (S-INTEG-8)
	rebindTokensOwnedBy(input: {
		readonly actor: Actor;
		readonly unbound: UnboundEnvelopeReading;
	}): Promise<readonly RebindOutcome[]>;
}

interface StoredTokenRow {
	readonly id: string;
	readonly access_token_enc: Uint8Array | null;
	readonly refresh_token_enc: Uint8Array | null;
	readonly id_token_enc: Uint8Array | null;
	readonly token_key_version: number | null;
}

type RebindableColumn = "access_token_enc" | "refresh_token_enc" | "id_token_enc";

const REBINDABLE_COLUMNS: readonly (readonly [RebindableColumn, BoundColumn])[] = [
	["access_token_enc", "identity.access_token_enc"],
	["refresh_token_enc", "identity.refresh_token_enc"],
	["id_token_enc", "identity.id_token_enc"],
];

type ReboundTokens =
	| { readonly outcome: "absent" | "current" }
	| { readonly outcome: "rebound"; readonly tokens: EncryptedProviderTokens };

function hasStoredTokens(row: StoredTokenRow): boolean {
	return REBINDABLE_COLUMNS.some(([name]) => row[name] !== null);
}

async function reboundTokensOf(
	keys: KeyProvider,
	owner: string,
	row: StoredTokenRow,
	unbound: UnboundEnvelopeReading,
): Promise<ReboundTokens> {
	const keyVersion = row.token_key_version;
	if (!hasStoredTokens(row)) {
		return { outcome: "absent" };
	}
	//a ciphertext whose key version column is empty can be read under no key (S-INTEG-1)
	if (keyVersion === null) {
		throw new KeyError("key_version_unknown");
	}
	const rewritten: Partial<Record<RebindableColumn, Uint8Array<ArrayBuffer> | null>> = {};
	const versions = new Set<number>();
	let changed = false;
	for (const [name, column] of REBINDABLE_COLUMNS) {
		const stored = row[name];
		if (stored === null) {
			rewritten[name] = null;
			continue;
		}
		const ciphertext = Uint8Array.from(stored);
		const rebound = await rebindEnvelope(
			keys,
			{ column, owner, row: row.id },
			{ keyVersion, ciphertext },
			unbound,
		);
		rewritten[name] = rebound?.ciphertext ?? ciphertext;
		versions.add(rebound?.keyVersion ?? keyVersion);
		changed ||= rebound !== null;
	}
	//the three ciphertexts of a row must share the one key version the row stores (E-3121)
	if (versions.size > 1) {
		throw new VelveError("internal_error");
	}
	if (!changed) {
		return { outcome: "current" };
	}
	return {
		outcome: "rebound",
		tokens: {
			accessTokenEnc: rewritten.access_token_enc ?? null,
			refreshTokenEnc: rewritten.refresh_token_enc ?? null,
			idTokenEnc: rewritten.id_token_enc ?? null,
			tokenKeyVersion: [...versions][0] ?? keyVersion,
		},
	};
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

//a driver hands jsonb back decoded or as the text PostgreSQL sent
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

function factParameters(
	facts: IdentityFacts,
	encrypted: EncryptedProviderTokens,
): readonly unknown[] {
	return [
		facts.providerEmail,
		facts.providerEmailVerified,
		facts.profile === null || facts.profile === undefined ? null : JSON.stringify(facts.profile),
		facts.scopes.join(" "),
		encrypted.accessTokenEnc,
		encrypted.refreshTokenEnc,
		encrypted.idTokenEnc,
		encrypted.tokenKeyVersion,
		facts.tokenLifetimeInSeconds,
	];
}

export function createOAuthIdentityRepository(options: {
	readonly driver: Driver;
	readonly schema: string;
	readonly keys: KeyProvider;
}): OAuthIdentityRepository {
	const schema = assertSchemaName(options.schema);
	const identities = qualifiedTableName(schema, "identity");

	//the token columns and the key version must never leave the database
	const RETURNED_COLUMNS = `id, user_id, provider, subject, provider_email, provider_email_verified,
profile, array_to_string(scopes, ' ') AS scopes, token_expires_at, created_at`;

	const findStatement = `SELECT ${RETURNED_COLUMNS} FROM ${identities}
/* no owner predicate: S-LINK-1, this lookup is what decides which account the identity belongs to */
WHERE provider = $1 AND subject = $2`;

	const insertStatement = `INSERT INTO ${identities}
(user_id, provider, subject, provider_email, provider_email_verified, profile, scopes,
 access_token_enc, refresh_token_enc, id_token_enc, token_key_version, token_expires_at, id)
VALUES ($1, $2, $3, $4, $5, $6::jsonb, string_to_array($7::text, ' '), $8, $9, $10, $11,
        now() + make_interval(secs => $12::double precision), $13)
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
WHERE provider = $1 AND subject = $2 AND id = $12
RETURNING ${RETURNED_COLUMNS}`;

	const listStatement = `SELECT ${RETURNED_COLUMNS} FROM ${identities}
WHERE user_id = $1 ORDER BY created_at, id`;

	const storedTokensStatement = `SELECT id, access_token_enc, refresh_token_enc, id_token_enc,
token_key_version FROM ${identities} WHERE user_id = $1 ORDER BY id`;

	//a write to the row between the read and the rewrite must make the rewrite lose rather than be overwritten (E-3121)
	const replaceTokensStatement = `UPDATE ${identities}
SET access_token_enc = $3, refresh_token_enc = $4, id_token_enc = $5, token_key_version = $6
WHERE id = $1 AND user_id = $2 AND token_key_version = $7
  AND access_token_enc IS NOT DISTINCT FROM $8 AND refresh_token_enc IS NOT DISTINCT FROM $9
  AND id_token_enc IS NOT DISTINCT FROM $10
RETURNING id`;

	//the tokens are bound to a row id that exists before the insert (E-3113)
	async function insertOwnedBy(ownerId: string, facts: IdentityFacts): Promise<Identity | null> {
		const identityId = randomUuid();
		const encrypted = await encryptedProviderTokens(
			options.keys,
			{ owner: ownerId, identityId },
			facts.tokens,
		);
		const [row] = await options.driver.query<IdentityRow>(insertStatement, [
			ownerId,
			facts.provider,
			facts.subject,
			...factParameters(facts, encrypted),
			identityId,
		]);
		return row === undefined ? null : toIdentity(row);
	}

	return {
		async findIdentityBySubject({ provider, subject }) {
			const [row] = await options.driver.query<IdentityRow>(findStatement, [provider, subject]);
			return row === undefined ? null : { identity: toIdentity(row), userId: row.user_id };
		},

		insertIdentity: ({ actor, ...facts }) => insertOwnedBy(actor, facts),

		insertIdentityOfSignIn: ({ userId, ...facts }) => insertOwnedBy(userId, facts),

		async refreshIdentity({ existing, ...facts }) {
			const encrypted = await encryptedProviderTokens(
				options.keys,
				{ owner: existing.userId, identityId: existing.identity.id },
				facts.tokens,
			);
			const [row] = await options.driver.query<IdentityRow>(refreshStatement, [
				facts.provider,
				facts.subject,
				...factParameters(facts, encrypted),
				existing.identity.id,
			]);
			//tokens bound to one identity row are never written to another (E-3123)
			if (row === undefined) {
				throw new ConcealedError("state_not_found");
			}
			return toIdentity(row);
		},

		async rebindTokensOwnedBy({ actor, unbound }) {
			const rows = await options.driver.query<StoredTokenRow>(storedTokensStatement, [actor]);
			const outcomes: RebindOutcome[] = [];
			for (const row of rows) {
				const rebound = await reboundTokensOf(options.keys, actor, row, unbound);
				if (rebound.outcome !== "rebound") {
					outcomes.push(rebound.outcome);
					continue;
				}
				const replaced = await options.driver.query(replaceTokensStatement, [
					row.id,
					actor,
					rebound.tokens.accessTokenEnc,
					rebound.tokens.refreshTokenEnc,
					rebound.tokens.idTokenEnc,
					rebound.tokens.tokenKeyVersion,
					row.token_key_version,
					row.access_token_enc,
					row.refresh_token_enc,
					row.id_token_enc,
				]);
				outcomes.push(replaced.length === 1 ? "rebound" : "lost");
			}
			return outcomes;
		},

		async listIdentitiesOwnedBy({ actor }) {
			const rows = await options.driver.query<IdentityRow>(listStatement, [actor]);
			return rows.map(toIdentity);
		},
	};
}
