# @velve/auth — Reference

Every function, parameter, configuration option and table. This file grows with
the implementation; a feature is not finished until it is documented here.

Concepts and rationale are not repeated here — they are in
[`CASE-STUDY.md`](./CASE-STUDY.md). This file states what things do.

## Contents

- [Package entry points](#package-entry-points)
- [Schema](#schema)

## Package entry points

The package is ESM only and exposes the following subpaths.

| Import | Contains |
|---|---|
| `@velve/auth` | `createVelveAuth()` and every core operation |
| `@velve/auth/http` | `toWebHandler()` — `(Request) => Promise<Response>` |
| `@velve/auth/client` | the typed client, derived from the same route declaration |
| `@velve/auth/pg` | driver for `node-postgres` |
| `@velve/auth/postgres-js` | driver for `postgres.js` |
| `@velve/auth/neon` | driver for `@neondatabase/serverless` |
| `@velve/auth/import` | the migration module; its heavier dependencies load only here |
| `@velve/auth/schema` | the generated SQL and the migration runner |
| `@velve/auth/testing` | test helpers — clock control, deterministic randomness |

There is no default export from any subpath.

### `VELVE_AUTH_VERSION`

```ts
import { VELVE_AUTH_VERSION } from "@velve/auth";
```

`string` — the version of the package, as published.

## Schema

Everything lives in its own PostgreSQL schema, `velve` by default, so nothing
collides with the application's own tables. Sixteen tables.

`user` is a reserved word in SQL, but `velve.user` is valid without quoting
because PostgreSQL accepts any keyword after the dot. No statement in this
library uses an unqualified name.

Storage rule: what the server only compares is hashed — session tokens, one-time
tokens, challenges, recovery codes. What it needs in cleartext is encrypted —
the TOTP secret, third-party OAuth tokens, the PKCE verifier, the PHC string.
Passwords are derived with a KDF. Nothing confidential is in cleartext.

### `velve.user`

The identity. Deliberately minimal: no profile data.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | primary key, `gen_random_uuid()` |
| `email` | `text` | normalised, lowercase; unique where not null |
| `email_verified_at` | `timestamptz` | null until the address is proven |
| `username` | `text` | display form, as entered (NFKC) |
| `username_key` | `text` | comparison form, NFKC + casefold; unique where not null |
| `disabled_at` | `timestamptz` | set means the account is disabled |
| `imported_from` | `text` | `supabase`, `clerk`, `auth0`, `firebase` or `nextauth` |
| `imported_at` | `timestamptz` | when the import ran |
| `created_at`, `updated_at` | `timestamptz` | |

Constraints: `user_email_normalized` (the address equals its own lowercase),
`user_username_normalized` (same for `username_key`), `user_username_pairing`
(`username` and `username_key` are set together or not at all). Migration 2 adds
`user_identity_mode`, the check that materialises the configured identity mode.

### `velve.password_credential`

One row per user with a password.

| Column | Type | Notes |
|---|---|---|
| `user_id` | `uuid` | primary key, cascades from `velve.user` |
| `phc` | `bytea` | AES-256-GCM over the canonical PHC string, purpose `password-enc` |
| `key_version` | `integer` | the `password-enc` version `phc` was written under, default 1 |
| `scheme` | `text` | cleartext, so the estate can be surveyed without a key |
| `created_at`, `updated_at` | `timestamptz` | |

### `velve.identity`

A linked provider identity. `(provider, subject)` is the only linking key; the
email address is an attribute, never a key.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | primary key |
| `user_id` | `uuid` | cascades from `velve.user`, indexed |
| `provider`, `subject` | `text` | unique together; `subject` is the provider's stable id, never an email |
| `provider_email` | `text` | as reported by the provider |
| `provider_email_verified` | `boolean` | per identity, default false |
| `profile` | `jsonb` | raw claims; the application reads them, the library does not |
| `access_token_enc`, `refresh_token_enc`, `id_token_enc` | `bytea` | AES-256-GCM, only when the application asks for token storage |
| `token_key_version` | `integer` | the key version those three were written under |
| `scopes` | `text[]` | |
| `token_expires_at` | `timestamptz` | |
| `created_at`, `updated_at` | `timestamptz` | |

### `velve.session`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | primary key |
| `user_id` | `uuid` | cascades from `velve.user`, indexed, **immutable** |
| `token_sha256` | `bytea` | SHA-256 of the session token, unique |
| `created_at`, `last_used_at` | `timestamptz` | |
| `idle_expires_at`, `absolute_expires_at` | `timestamptz` | `absolute_expires_at` is indexed for the sweep |
| `factors` | `text[]` | `password`, `totp`, `webauthn`, `recovery`, `oauth` |
| `ip` | `inet` | truncated unless `sessionMetadata` says otherwise |
| `user_agent` | `text` | truncated unless `sessionMetadata` says otherwise |

The trigger `session_user_id_immutable` makes any `UPDATE` that names `user_id`
fail with SQLSTATE 23514, whether or not the value would change. A session
changes owner only by being replaced: insert the new row and delete the old one
in one transaction (E-23).

### `velve.one_time_token`

| Column | Type | Notes |
|---|---|---|
| `token_sha256` | `bytea` | primary key |
| `purpose` | `text` | `email_verify`, `password_reset`, `email_change`, `magic_link` |
| `user_id` | `uuid` | cascades from `velve.user`; indexed together with `purpose` |
| `payload` | `jsonb` | |
| `created_at` | `timestamptz` | |
| `expires_at` | `timestamptz` | indexed for the sweep |

### `velve.pending_authentication`

The state between the first factor and the second.

| Column | Type | Notes |
|---|---|---|
| `token_sha256` | `bytea` | primary key |
| `user_id` | `uuid` | cascades from `velve.user` |
| `factors_completed` | `text[]` | |
| `attempts` | `integer` | default 0, counts against five |
| `created_at` | `timestamptz` | |
| `expires_at` | `timestamptz` | indexed for the sweep |

### `velve.totp_credential`

| Column | Type | Notes |
|---|---|---|
| `user_id` | `uuid` | primary key, cascades from `velve.user` |
| `secret_enc` | `bytea` | AES-256-GCM, purpose `totp-enc` |
| `key_version` | `integer` | the `totp-enc` version |
| `confirmed_at` | `timestamptz` | null until the first correct code |
| `created_at` | `timestamptz` | |

### `velve.totp_used_step`

| Column | Type | Notes |
|---|---|---|
| `user_id`, `time_step` | `uuid`, `bigint` | primary key together; the pair is what serialises concurrent submissions |
| `expires_at` | `timestamptz` | indexed for the sweep |

### `velve.recovery_code`

One row per code, never a blob.

| Column | Type | Notes |
|---|---|---|
| `user_id`, `code_hmac` | `uuid`, `bytea` | primary key together |
| `key_version` | `integer` | the `token-pepper` version the HMAC was taken under, default 1 |
| `created_at` | `timestamptz` | |

### `velve.webauthn_credential`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | primary key |
| `user_id` | `uuid` | cascades from `velve.user`, indexed |
| `credential_id` | `bytea` | unique |
| `public_key` | `bytea` | |
| `sign_count` | `bigint` | default 0 |
| `transports` | `text[]` | |
| `aaguid` | `uuid` | |
| `backup_eligible`, `backup_state` | `boolean` | eligible means a synchronised passkey |
| `user_verified_at_registration` | `boolean` | |
| `label` | `text` | |
| `created_at`, `last_used_at` | `timestamptz` | |

### `velve.webauthn_challenge`

| Column | Type | Notes |
|---|---|---|
| `challenge_sha256` | `bytea` | primary key |
| `purpose` | `text` | `register` or `authenticate` |
| `user_id` | `uuid` | cascades from `velve.user`; null for a discoverable sign-in |
| `created_at` | `timestamptz` | |
| `expires_at` | `timestamptz` | indexed for the sweep |

### `velve.oauth_flow`

| Column | Type | Notes |
|---|---|---|
| `state_sha256` | `bytea` | primary key |
| `provider` | `text` | |
| `pkce_verifier_enc` | `bytea` | AES-256-GCM, purpose `pkce-enc` |
| `key_version` | `integer` | the `pkce-enc` version |
| `nonce` | `text` | for OIDC |
| `redirect_path` | `text` | a path, never a full URL |
| `link_to_user_id` | `uuid` | cascades from `velve.user`; set means the flow links rather than signs in |
| `created_at` | `timestamptz` | |
| `expires_at` | `timestamptz` | indexed for the sweep |

### `velve.rate_bucket`

| Column | Type | Notes |
|---|---|---|
| `bucket_key` | `text` | primary key |
| `tokens` | `real` | negative means the request is rejected |
| `updated_at` | `timestamptz` | |
| `expires_at` | `timestamptz` | indexed for the sweep |

### `velve.import_mapping`

Makes an import repeatable: the same source row maps to the same account.

| Column | Type | Notes |
|---|---|---|
| `source`, `source_id` | `text` | primary key together; `source_id` is the source primary key, unchanged |
| `user_id` | `uuid` | cascades from `velve.user`, indexed |
| `run_id` | `uuid` | which run created the row, indexed |
| `imported_at` | `timestamptz` | |

### `velve.password_reset_required`

Legacy hashes that could not be carried over.

| Column | Type | Notes |
|---|---|---|
| `user_id` | `uuid` | primary key, cascades from `velve.user` |
| `reason` | `text` | `unsupported_scheme`, `hash_not_exported`, `missing_parameters`, `malformed`, `no_password_in_source` |
| `source` | `text` | |
| `detail` | `text` | for example `clerk:phpass` |
| `created_at` | `timestamptz` | |

### `velve.schema_migration`

The migration ledger.

| Column | Type | Notes |
|---|---|---|
| `version` | `integer` | primary key |
| `name` | `text` | |
| `applied_at` | `timestamptz` | |
| `checksum` | `text` | SHA-256 of the migration's SQL, hex |

## Migrations

Migrations are versioned, forward-only and transactional. Each one runs in its
own transaction and is recorded in `velve.schema_migration` with the SHA-256 of
its SQL.

The same SQL is shipped twice: as files under `migrations/` for an operator who
wants to read or apply it with their own tooling, and embedded in the module the
runner executes, because the library reads no files at runtime. A test compares
the two byte for byte.

| File | Version | Applies |
|---|---|---|
| `0001_initial_schema.sql` | 1 | all sixteen tables in their final form, plus the `velve.session` owner trigger |
| `0002_identity_email.sql` | 2 | `CHECK (email IS NOT NULL)` |
| `0002_identity_username.sql` | 2 | `CHECK (username IS NOT NULL)` |
| `0002_identity_username_email.sql` | 2 | `CHECK (email IS NOT NULL AND username IS NOT NULL)` |

Exactly one of the three version-2 files is applied — the one matching the
configured identity mode. Changing the mode of a database that has already
migrated is a schema change of its own; the runner will report the recorded
migration 2 as changed rather than silently swapping the constraint.

Everything in this section is imported from `@velve/auth/schema`.

```ts
import {
	assertSchemaUpToDate,
	coreMigrations,
	readSchemaStatus,
	runMigrations,
} from "@velve/auth/schema";
```

### `coreMigrations(identityMode)`

Returns the shipped plan for one identity mode: `"email"`, `"username"` or
`"username_email"`.

### `runMigrations(options)`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `driver` | `Driver` | — | where the statements run |
| `migrations` | `readonly Migration[]` | — | the plan; core migrations plus any a plugin contributes |
| `schema` | `string` | `"velve"` | the PostgreSQL schema to migrate |

A `Migration` is `{ version: number; name: string; sql: string }`. The checksum
is taken over the SQL as shipped, so the same migration in two differently named
schemas hashes the same.

`schema` must be a lowercase unquoted identifier of at most 63 bytes and may not
be a PostgreSQL reserved key word; anything else raises `InvalidIdentifierError`
before a statement is sent.

**How the schema name reaches the SQL.** The shipped SQL says `velve`. When
`schema` is something else, the runner cuts each statement into regions —
comment, string literal, quoted identifier, dollar-quoted body, code — and
replaces the name only in code, and there only in two positions: where it
qualifies something (`velve.session`) and where a `CREATE`, `DROP` or
`ALTER SCHEMA` names it. So a migration that inserts the string `'velve'` or
declares a column named `velve` keeps both, and a qualifier naming another
schema is left alone — a migration that reaches into `public` still reaches into
`public`. A comment mentioning `velve.user` also keeps the original name; the
rewrite changes what runs, not what is written about it.

**A dollar-quoted body is not rewritten, and a migration that needs it to be is
refused.** A function body is arbitrary code in an arbitrary language, and
substituting a word inside it is not something this scanner can do safely. So a
migration whose `$$ … $$` body qualifies `velve` is rejected before the
transaction opens, with `UnrewritableMigrationError`, code
`migration_unrewritable_body` — rather than applied and left pointing at a schema
that is not the configured one. A body that qualifies nothing is unaffected.

What the check does **not** see is a name inside a string inside the body, which
is how dynamic SQL carries it:

```sql
EXECUTE 'SELECT count(*) FROM velve.user' INTO n;   -- applied, and broken at the first call
```

So for a body that builds SQL at run time the rule is mandatory rather than
advisory: **build the qualified name from a schema value available at run time
and quote it with `format('%I.user', …)`** — inside a trigger function that value
is `TG_TABLE_SCHEMA`, otherwise it is an argument the caller passes. Setting the
function's `search_path` in the migration does not help: `SET search_path = velve`
stands neither before a dot nor after `CREATE SCHEMA`, so it is not rewritten
either. A plugin that can do neither should ship its migration only for the
default schema name.

In the other direction the check errs toward refusing: an attribute access it
cannot parse as one — a plpython body holding an object named `velve` — is
rejected although it means no schema. That asymmetry is deliberate. A refusal is
loud and has a documented way out; an accepted broken function is silent.

**Statements run one at a time.** The runner cuts the migration on the
semicolons that are not inside a string, a comment or a dollar-quoted body, and
sends each statement through `Driver.query` on its own, inside the one
transaction. That keeps `query`'s contract — one statement per call — true for
every driver, including one built on the extended protocol.

Returns `{ appliedVersions, currentVersion }` — the versions this call applied,
and the highest version in the ledger afterwards.

What the runner does, in order:

1. Refuses a plan in which two migrations claim the same version
   (`migration_duplicate_version`).
2. Creates the schema and the ledger table if they are missing.
3. Compares the checksum of every already-applied migration against the plan and
   refuses the whole run if one has changed (`migration_checksum_changed`). A
   migration that has been applied is history; editing it is a mistake, not an
   update.
4. Applies each pending migration in version order, each in its own transaction.

Every one of those transactions first takes a PostgreSQL advisory lock derived
from the schema name, then re-reads the ledger inside the lock. Two processes
starting at once therefore serialise: the second finds the migration already
applied and skips it. The lock is transaction-scoped, so it needs no session
pinning from the driver and cannot be left behind by a crash.

### What a plugin migration must do

A plugin may add tables in the `velve` schema under its own prefix. Any column
that references `velve.user(id)` must do so with `ON DELETE CASCADE`, and any
column named `user_id` must carry such a foreign key. After each migration — core
or plugin — the runner checks the catalogue inside the same transaction and
rolls the migration back if either rule is broken, raising
`MissingCascadeError` with the code `migration_missing_cascade` (S-TOKEN-6).
Deleting a user has to empty every table that holds their rows, and a check that
reads the catalogue cannot be forgotten the way a review can.

Ordinary and partitioned tables are both checked, the parent as well as the leaf.

Two limits are worth knowing. The check runs when a migration is applied, so a
constraint dropped by hand afterwards is not noticed until the next migration
runs — the guard is not a monitor. And it reads only the configured schema, so a
table in another schema referencing `velve.user` is outside its view; the
architecture puts everything of this library in one schema, and a foreign table
that references `velve.user` is the application's own to get right.

### `readSchemaStatus(options)` and `assertSchemaUpToDate(options)`

The version contract between the package and the database (F35, F37). Both take
the same options as `runMigrations` and neither writes anything — a database
that has never been migrated stays untouched and reports version 0.

`readSchemaStatus` returns:

| Field | Type | Meaning |
|---|---|---|
| `currentVersion` | `number` | the highest version in the ledger, 0 if there is none |
| `expectedVersion` | `number` | the highest version in the plan this package carries |
| `appliedVersions` | `readonly number[]` | every version in the ledger, ascending |
| `pendingVersions` | `readonly number[]` | versions in the plan that the ledger does not have |
| `changedVersions` | `readonly number[]` | versions applied under a checksum the plan no longer produces |
| `upToDate` | `boolean` | true when both lists are empty |

`assertSchemaUpToDate` returns the same status when `upToDate` is true and
otherwise throws `SchemaVersionMismatchError`, code `schema_version_mismatch`,
whose message names both versions and which carries the status as `.status`.
Call it at startup: a schema behind the package is a startup error, not a
warning.

## The driver interface

Every statement the library runs goes through one small interface. The driver is
a parameter of `createVelveAuth`, never an import of the core, so the core has no
database dependency of its own.

```ts
interface Driver {
	query<T>(sql: string, params: unknown[]): Promise<T[]>;
	transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T>;
}
```

| Member | Parameters | Returns |
|---|---|---|
| `query` | `sql` — a single statement with `$1`-style placeholders; `params` — one value per placeholder, empty when there are none | the result rows, in order |
| `transaction` | `fn` — receives a driver bound to the transaction's connection | whatever `fn` returns |

`transaction` commits when `fn` resolves and rolls back when it rejects. A driver
handed to `fn` is bound to one connection: statements it runs are inside the
transaction. Calling `transaction` on that bound driver joins the open
transaction rather than starting a second one, so a helper that wants a
transaction can be called from inside one.

There is no query builder and no ORM. All SQL is written by hand for PostgreSQL
14 or newer.

A driver never has to handle more than one statement per call: everything that
ships more than one — the migrations — is cut into statements before it reaches
`query`.

`createNodePostgresDriver` is the reference implementation, and a driver for
another client is about forty lines. `NodePostgresPool.query` is declared with
method syntax on purpose: that is what makes `node-postgres`' overloaded `query`
assignable to it without a cast.

### `@velve/auth/pg`

```ts
import { Pool } from "pg";
import { createNodePostgresDriver } from "@velve/auth/pg";

const driver = createNodePostgresDriver(new Pool({ connectionString }));
```

`createNodePostgresDriver(pool)` returns a `Driver`. The pool is created, owned
and closed by the application; the library never opens a connection and never
reads a connection string.

`pg` is not a dependency of this package. The parameter is typed structurally, so
a `Pool` from `node-postgres` satisfies it without the package being installed:

| Type | Shape |
|---|---|
| `NodePostgresQueryConfig` | `{ text: string; values: unknown[] }` |
| `NodePostgresResult` | `{ rows: unknown[] }` |
| `NodePostgresClient` | `query(config)`, `release()` |
| `NodePostgresPool` | `query(config)`, `connect()` |

`query` outside a transaction runs on a pooled connection. `transaction` checks
out one connection, runs `BEGIN`, calls the body, and runs `COMMIT`; if the body
throws, it runs `ROLLBACK` and rethrows the body's error. The connection is
released in both cases. A failing `ROLLBACK` does not replace the error that
caused it.

### Identifiers

`schema` and table names reach SQL as identifiers, never as parameters, so they
are checked before use. A name must match `^[a-z_][a-z0-9_$]*$` and stay within
63 bytes; anything else raises `InvalidIdentifierError` with the code
`invalid_identifier`. Mixed-case and quoted identifiers are rejected rather than
quoted — there is no case in which the library needs one.

## Repositories

Ten of the thirty-three advisories behind the security requirements had one
shape: a missing `AND user_id = :actor`. The countermeasure is not review, it is
a signature that cannot be satisfied without naming the acting user (E-43).

### `Actor`

```ts
import { actorOfResolvedSession, type ResolvedSession } from "@velve/auth";
```

`Actor` is a branded `string`, so a bare string is not one and the mistake does
not compile. It is obtained from `actorOfResolvedSession(session)`, which is
called with the session the library itself resolved; no handler builds an actor
from a request body, a query string or a header (S-OWNER-7).

`ResolvedSession` is the nominal type session resolution has to return. Today
`actorOfResolvedSession` accepts any `{ userId: string }`, which means a caller
one line away can still mint an actor from an untrusted string. Closing that
door is one change to this parameter, and it belongs with the feature that owns
session resolution; `CASE-STUDY.md` E-93 records the exact change and the shape
that must stop compiling.

### `createOwnedRowRepository(options)`

```ts
import { createOwnedRowRepository } from "@velve/auth";
```

Builds a repository over one table whose rows belong to a user.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `driver` | `Driver` | — | where the statements run |
| `schema` | `string` | — | the PostgreSQL schema |
| `table` | `string` | — | the table, without the schema |
| `idColumn` | `string` | `"id"` | the column that addresses a single row |
| `ownerColumn` | `string` | `"user_id"` | the column that holds the owner; `velve.oauth_flow` uses `link_to_user_id` |
| `updatableColumns` | `readonly string[]` | `[]` | the columns `updateOwnedRow` may write |

Every method takes `actor` and there is no method without it. The owner
condition is part of the statement, not a branch around it (S-OWNER-2), and it
is written unconditionally by the builder, so no call site can leave it out.

| Method | Statement | Result |
|---|---|---|
| `findOwnedRow({ id, actor })` | `SELECT … WHERE id = $1 AND user_id = $2` | the row, or `null` |
| `listOwnedRows({ actor })` | `SELECT … WHERE user_id = $1` | the rows, ordered by the id column |
| `updateOwnedRow({ id, actor, values })` | `UPDATE … WHERE id = $1 AND user_id = $2 RETURNING *` | the updated row, or `null` |
| `deleteOwnedRow({ id, actor })` | `DELETE … WHERE id = $1 AND user_id = $2 RETURNING *` | the deleted row, or `null` |
| `deleteAllOwnedRows({ actor })` | `DELETE … WHERE user_id = $1 RETURNING id` | how many rows were removed |

An empty result is the refusal. A row that belongs to someone else and a row
that never existed produce the same `null`, so nothing leaks the difference
(S-OWNER-8).

`values` may only name a column listed in `updatableColumns`; anything else
raises `UnknownColumnError` with the code `unknown_column`. The owner column is
never updatable through this repository — changing who owns a row is not an
update.

## Key management

> **Losing the root key means losing every password.**
>
> The password hash is not stored as a PHC string but as AES-256-GCM ciphertext
> over that string, under the purpose key `password-enc` (L-2). Without the root
> key that produced it, no stored password can be verified any more, and no
> password reset flow can recover them either — a reset writes a new hash, it
> does not read the old one. The same holds for TOTP secrets, stored OAuth
> tokens, PKCE verifiers and recovery codes. Back the root key up outside the
> database, and keep every version that any stored row still refers to.
>
> This is the same risk class as a pepper, and it is the price L-2 pays for the
> property that a stolen database dump on its own is worth nothing.

### Purposes

One root key, six working keys, derived with HKDF-SHA256 and separated by one
derivation context per purpose (section 3.8).

| Purpose | Key type | Used for |
|---|---|---|
| `cookie-sig` | HMAC-SHA256 | signing the library's cookies |
| `token-pepper` | HMAC-SHA256 | recovery codes and the identifier-keyed counter |
| `totp-enc` | AES-256-GCM | `totp_credential.secret_enc` |
| `oauth-token-enc` | AES-256-GCM | `identity.access_token_enc` and its siblings |
| `pkce-enc` | AES-256-GCM | `oauth_flow.pkce_verifier_enc` |
| `password-enc` | AES-256-GCM | `password_credential.phc` |

`KEY_PURPOSES` is the tuple of those six names; `KeyPurpose` is the union
derived from it. The set is closed — a name outside it does not type-check.
`EncryptionKeyPurpose` and `SigningKeyPurpose` are the two halves of that
union, derived from the same tuple. The four encryption functions take
`EncryptionKeyPurpose`, so passing `cookie-sig` or `token-pepper` to them does
not compile; a caller without types gets a `KeyError` with the code
`purpose_cannot_encrypt`.

Signing purposes are imported as HMAC keys and encryption purposes as AES-GCM
keys. A value produced under one purpose therefore cannot be read under
another: Web Crypto rejects the key before any code of this library runs
(S-KEY-2).

### `KeyProvider`

```ts
interface KeyProvider {
	current(purpose: KeyPurpose): Promise<{ version: number; key: CryptoKey }>;
	byVersion(purpose: KeyPurpose, version: number): Promise<CryptoKey | null>;
}
```

- `current(purpose)` — the one version to write with, and its key.
- `byVersion(purpose, version)` — the key of any version still in the ring, for
  reading. A version that is no longer in the ring resolves to `null`, never to
  an exception.

The core takes keys from this interface and never from `process.env`. On a
runtime that hands secrets over as a capability rather than as an environment
variable, the implementation is replaced and nothing else changes (section 2.6).

### `rootKeyProvider(input)`

```ts
rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: rootKey } });
```

The default implementation. It derives all six purpose keys from the root key
of each version and caches them for the lifetime of the provider.

| Option | Type | Meaning |
|---|---|---|
| `currentVersion` | `number` | the version `current()` writes with; must be present in `keysByVersion` |
| `keysByVersion` | `Readonly<Record<number, string>>` | the key ring: version to base64url root key, at least 32 bytes each |

Root keys are read in canonical base64url only. Padding is optional but must be
one or two `=` at the end of a string whose length is a multiple of four, and
trailing bits belonging to no byte must be zero — a key with a mistyped last
character is rejected rather than decoded to the correct bytes. **A leading or
trailing space or newline is part of the string and makes it
`root_key_malformed`**; the value is not trimmed, because trimming would bring
back exactly the aliasing the canonical reading removes. Each key of
`keysByVersion` must be the plain decimal spelling of its version; `0x10` and
`1e2` are refused.

A key version is a positive PostgreSQL `integer`, so between `1` and
`2147483647`. That is the same range the `key_version` columns hold.

Construction fails immediately — the library does not start — when the root key
is missing, is not base64url, or is shorter than 32 bytes (S-KEY-6). The errors
are `KeyError`s with the codes `root_key_missing`, `root_key_malformed`,
`root_key_too_short` and `key_version_out_of_range`.

### Rotation

1. Generate a new root key and add it to `keysByVersion` under a higher version.
2. Set `currentVersion` to it. New values are written under the new version;
   old values keep opening because their version is still in the ring.
3. Re-encrypt the stored values at leisure — for passwords this rides along with
   the rehash after a successful sign-in (section 3.3, step 6).
4. Remove the old version from `keysByVersion` once nothing refers to it. A row
   that still does now fails with `key_version_unknown` rather than silently.

Rotation never ends a session. Sessions are opaque database rows and are bound
to no key at all (section 3.8).

### Encrypting a value

Two shapes, one representation of the version.

```ts
const { keyVersion, ciphertext } = await encryptWithPurposeKey(keys, purpose, plaintext);
const plaintext = await decryptWithPurposeKey(keys, purpose, keyVersion, ciphertext);
```

`encryptWithPurposeKey` returns the ciphertext and the version separately, for
the rows that hold the version in a column of their own —
`password_credential.key_version` (L-2), `recovery_code.key_version` (L-3),
`totp_credential.key_version`, `oauth_flow.key_version` and
`identity.token_key_version`. `ciphertext` contains the nonce followed by the
AES-256-GCM output and is what goes into the `bytea` column.

```ts
const envelope = await sealEnvelope(keys, purpose, plaintext);
const plaintext = await openEnvelope(keys, purpose, envelope);
```

`sealEnvelope` puts the version inside the value instead (E-44). The layout is:

| Bytes | Content |
|---|---|
| 1 | length of the algorithm label |
| 7 | the label, currently `A256GCM` |
| 4 | key version, big-endian signed 32-bit |
| 12 | nonce |
| rest | AES-256-GCM ciphertext with its 16-byte tag |

The algorithm label comes first so that changing the cipher later does not
invalidate stored data (section 2.4). Both shapes agree on the version: the
four bytes in the envelope hold exactly the integer the column would hold.

**The first twelve bytes — the label and the version — are the additional data
of every AES-256-GCM operation (E-65).** Rewriting either fails the
authentication tag. The column shape passes the same twelve bytes, so its
`key_version` column is authenticated too even though it is stored apart from
the ciphertext. This is a property of the format, not of the code: it cannot be
added to a deployment that already holds encrypted values.

`openEnvelope` fails with `envelope_malformed` for a value too short to carry a
header, `envelope_algorithm_unsupported` for a label this version does not
know, `ciphertext_malformed` below the length of a nonce and a tag, and
`key_version_unknown` for a version that has left the ring. A wrong purpose, a
wrong key, a tampered byte or a rewritten header fails with
`authentication_failed`.

### `randomBytes(length)`

`Uint8Array` of `length` bytes from `crypto.getRandomValues`. Every secret the
library generates comes from here and from nowhere else (S-RAND-1, S-RAND-5).

### `equalsInConstantTime(left, right)`

`boolean`. An XOR loop over two `Uint8Array`s that does not exit early on the
first differing byte. Sequences of different length return `false` at once —
the length is not the secret. `crypto.timingSafeEqual` is deliberately not used
because it exists only on Node (section 2.7).

### `KeyError`

Every failure of this module is a `KeyError` with a `code` from a fixed set:
`root_key_missing`, `root_key_too_short`, `root_key_malformed`,
`key_version_out_of_range`, `key_version_unknown`,
`key_material_not_exportable`, `purpose_cannot_encrypt`,
`ciphertext_malformed`, `envelope_malformed`, `envelope_algorithm_unsupported`,
`authentication_failed`. The message is fixed per code, so no key material can
reach an error string.

That includes the failure a caller most has to handle: a ciphertext that does
not authenticate arrives as `authentication_failed`, not as the exception type
of whatever runtime the cipher ran on. `if (error instanceof KeyError)` covers
the adversarial path as well as the configuration ones. The one thing it does
not cover is a fault of the runtime underneath — a broken `crypto.subtle`
during encryption surfaces as itself, deliberately.

There is one error class and a code on it, rather than one class per failure.
Callers switch on `error.code`; `instanceof KeyError` separates this module's
refusals from a fault of the runtime underneath it.
