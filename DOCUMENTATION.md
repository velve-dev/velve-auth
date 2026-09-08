# @velve/auth — Reference

Every function, parameter, configuration option and table. This file grows with
the implementation; a feature is not finished until it is documented here.

Concepts and rationale are not repeated here — they are in
[`CASE-STUDY.md`](./CASE-STUDY.md). This file states what things do.

## Contents

- [Package entry points](#package-entry-points)
- [Schema](#schema)
- [HTTP](#http)

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

`ResolvedSession` is the nominal type session resolution returns, and
`actorOfResolvedSession` takes nothing else. A hand-built `{ userId: "…" }` does
not compile, so the only way to an actor is through a session the library
resolved itself (E-93). The brand is asserted in session resolution and nowhere
else; a path that proves ownership differently — a redeemed one-time token, say
— brings its own actor and does not borrow this one.

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

## HTTP

The HTTP layer turns a route declaration into a request handler. It is the only
place that decides what a caller learns, which cookies exist, and which requests
run at all.

### `toWebHandler(auth, options?)`

```ts
import { toWebHandler } from "@velve/auth/http";

const handler = toWebHandler(auth, { basePath: "/api/auth" });

export const GET = handler;
export const POST = handler;
```

Both verbs must be wired. The route table carries `GET` routes as well as `POST`
ones — how many depends on the identity mode and the configuration, since the
table is filtered by both (3.15 D.3) — and a framework that only receives `POST`
answers 404 to every one of them.

`(Request) => Promise<Response>` — Web standards only, no Node built-ins.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `auth` | `{ http: HttpEnvironment }` | — | The instance; the handler reads its routes and its security settings from `auth.http`. |
| `options.basePath` | `string` | `""` | Where the handler is mounted. Compared segment by segment; a request outside it is a 404. Never derived from a header. |
| `options.clientAddress` | `(request: Request) => string \| null` | `() => null` | The client address for the rate limiter. A `Request` carries no connection address, so the adapter supplies it. `X-Forwarded-For` is never read by the library. |

Every response carries `Cache-Control: no-store` and `Vary: Cookie`, set by the
handler and not by the application (L-6). A response with a body carries
`Content-Type: application/json`; the library never produces HTML.

| Situation | Answer |
|---|---|
| Handler returned a value | `200` with that value as JSON |
| Handler returned `redirectTo(…)` | `302` with `Location: <path>` and no body |
| Handler returned nothing | `204` with no body |
| Method and path match no route | `404` with no body — the 25 error codes have no code for "no such route" |
| Anything threw | The status of the mapped error code, with the error envelope below |

The error envelope is the only body shape a failed request produces:

```json
{ "error": { "code": "rate_limited", "message": "Too many requests.", "retryAfterSeconds": 30 } }
```

The message follows from the code alone, so two failures with the same code
produce the same body. `retryAfterSeconds` is the single exception: it appears
only on `rate_limited`, and only when the limiter supplied a wait, which the
same answer also carries as a `Retry-After` header per RFC 9110. Two
`rate_limited` answers with different waits therefore differ; every other code
answers byte for byte the same, whatever produced it.

### Cookies

The library sets exactly two cookies, and the set is enumerated in
`src/core/http/cookies.ts` (S-COOKIE-6). A response that would set anything else
fails with `internal_error` rather than being sent.

| Cookie | Lifetime | Attributes |
|---|---|---|
| `__Host-velve_session` | the configured session lifetime | `HttpOnly; Secure; SameSite=Lax; Path=/` |
| `__Host-velve_pending` | 300 seconds | `HttpOnly; Secure; SameSite=Lax; Path=/` |

`SameSite` becomes `Strict` if the configuration asks for it. There is no option
for `HttpOnly`, `Secure`, `Domain`, `Path` or `SameSite=None`: the attribute set
is a closed union of two string literals, so no other set can be written down
(S-COOKIE-2). The `__Host-` prefix makes the browser enforce `Secure` and forbid
`Domain`, which is what rules out cookie tossing from a subdomain.

**The two names are not configurable.** They come from the enumeration in
`src/core/http/cookies.ts`, which is also what a response is checked against
before it is sent. Both the name and the value are checked against a token
charset first, so no name and no value can end a `Set-Cookie` field early and
append an attribute of its own.

The types behind them, for anyone reading `core/http/cookies.ts`:
`DEFAULT_COOKIE_NAMES` is the enumeration itself; `CookieInstruction` is one
cookie about to be written (`name`, `value`, `maximumAgeInSeconds`,
`attributes`), and every one of those four parts is checked before it is
interpolated into the header; `CookiePolicy` is what the writer is built from —
the names a request is read with, the `sameSite` choice and the session cookie's
`Max-Age`; and `CookieWriter` is what a handler sees on its context, four
methods named after roles rather than names.

A request that carries one of these two cookies twice is rejected with
`invalid_input` instead of one of the two values being picked (S-COOKIE-5).
Duplicates of other cookie names are ignored, because path-scoped application
cookies legitimately arrive twice.

A session token never appears in a response body: the handler moves a
`sessionToken` or `pendingToken` field out of the handler's output and into the
matching cookie (3.5). The directly called server method returns it, because
there is no cookie there.

### Origin checking

Origin checking is a per-route declaration, not something the handler applies on
its own: the check runs where `originCheck: "checked"` is declared, and every
core route except the OAuth callback declares it. Rate limiting reads the same
way — a route counts against the buckets its `rateLimit` field names, and
`"none"` means no bucket of that kind. What the handler guarantees is the order:
where a check is declared, nothing else runs before it.

The check parses both sides and compares `new URL(x).origin` for equality against the
configured `origins` (S-CSRF-2). There is no prefix, substring, wildcard or
pattern comparison anywhere in the library — the two published advisories in this
class were `startsWith` on a URL string. A missing `Origin` header, an opaque
`null` origin and an unparseable value are all rejected with
`origin_not_allowed`, and every rejection is byte-identical (S-CSRF-3).

`SameSite=Lax` is not the defence. It leaves state-changing `GET` open, it is
"same-site" rather than "same-origin" so any controlled subdomain passes it, and
it does nothing against login CSRF.

The check runs on the direct server method as well, which is why that method
takes an `origin` field (S-CSRF-1).

### `defineRoute(declaration)`

A route is declared once. The web handler and the server method are derived from
that declaration; the client is derived from the same types.

| Field | Type | Meaning |
|---|---|---|
| `name` | `string` | Dotted path, e.g. `"signIn.password"`. It is the object path of the server method and the rate limit key — never the raw request path. |
| `method` | `"GET" \| "POST"` | `GET` is for reading routes only. |
| `path` | `string` | Absolute, no empty segments, no trailing slash. A `:name` segment captures a path parameter into the input. |
| `input` | `ObjectValidator<Input>` | Built from `object()`, `string()` and `optional()`. A `POST` body with an undeclared key is rejected; on a `GET` route the undeclared query parameters are ignored, because providers append their own to the OAuth callback. |
| `errors` | `readonly VelveErrorCode[]` | The codes this route may produce. A contract, not a comment. |
| `caller` | `"anonymous" \| "session" \| "pending" \| "server_only"` | `session` resolves the session cookie or fails with `session_required`; `pending` is the only requirement that reads `__Host-velve_pending`; `server_only` has no HTTP route and answers 404. |
| `freshness` | `"not_required" \| "required"` | `required` needs `caller: "session"` and fails with `freshness_required` outside the freshness window. |
| `originCheck` | `"checked" \| "exempt"` | `exempt` exists for the OAuth callback, which has no `Origin` header by protocol. |
| `rateLimit` | `{ perIpAddress: BucketRule \| "none"; perAccount: BucketRule \| "none" }` | The buckets this route consumes. |
| `handler` | `(input, context) => Promise<Output>` | Returns the output, or nothing for a 204. |

The order in front of the handler is fixed and cannot be reordered by a caller or
a plugin: origin check, per-address rate limit, input parse, caller resolution,
handler.

Four declaration mistakes are start errors rather than request-time surprises: a
path that is not absolute or carries an empty or trailing segment; `freshness:
"required"` without `caller: "session"`; an input field named like one of the
five `ServerCallFields`; and, when the handler is built, a route table with a
duplicate name or with two routes answering the same folded path.

`defineRoute` returns the route the table holds. It carries the declaration's
metadata and its `input`, but **not** its `handler`: the invocation is reachable
only through the pipeline, so a caller holding a route cannot run it past the
origin check, the rate limit, the error map and the log (3.11).

### Path matching

The request path is compared to the declared path segment by segment, after
percent-decoding each segment once:

- Literal segments compare **case-insensitively over ASCII only**. `/TEST/ECHO`
  and `/test/echo` are one route and one rate-limit bucket (T-RATE-5); `A`–`Z`
  fold and nothing else does, so a Unicode look-alike such as U+212A does not
  fold into `k`.
- Empty segments and `.` segments are dropped, so `//sign-in/password/` is
  `/sign-in/password`. A `..` segment is refused outright.
- A segment whose percent-encoding is broken makes the request match nothing.
- `basePath` is compared the same way, segment by segment and folded, so a
  mounted handler behaves like the routes below it.
- `:name` in a declared path captures that segment into the input under `name`,
  with its case preserved.
- A `GET` route takes its input from the query string plus the captured path
  parameters. A query parameter that appears twice rejects the request with
  `invalid_input` rather than one of its values being chosen — the same rule as
  S-COOKIE-5 for cookies, and it matters on the OAuth callback, where `state`
  and `code` decide the outcome.

### Input validators

`object()`, `string()` and `optional()` live in `core/http` and appear only in
route declarations.

| Constructor | Accepts | Rejects |
|---|---|---|
| `string()` | a string, including `""` | everything else, `null` included |
| `optional(inner)` | `undefined`, or whatever `inner` accepts | what `inner` rejects; an explicit `null` is **not** absent |
| `object(shape)` | an object whose declared fields all parse | an array, `null`, a non-object, and — on a `POST` body — any key the shape does not declare |

Every rejection is `invalid_input` with the same message; no validator says
which field was wrong, and no input value is echoed back.

### `RequestContext`

| Field | Type | Meaning |
|---|---|---|
| `session` | `Session \| null` | Set for `caller: "session"`. |
| `pending` | `PendingAuthentication \| null` | Set for `caller: "pending"`. |
| `sessionToken` | `string \| null` | The raw cookie value, for routes that answer with `null` instead of failing when no session exists. |
| `ipAddress` | `string \| null` | From `options.clientAddress`. |
| `userAgent` | `string \| null` | From the `User-Agent` header. |
| `cookies` | `CookieWriter` | `setSession`, `clearSession`, `setPending`, `clearPending` — a role, never a name, so no unenumerated cookie can be written. |
| `enforceAccountRateLimit(normalisedIdentifier)` | `Promise<void>` | Consumes the per-account bucket. The identifier must already be normalised (L-5). A route that declares `perAccount` and reaches its handler without calling this writes a warning naming the route, whether the handler returned or threw; where the declaration says `perAccount: "none"` the call does nothing. |

`Session` and `PendingAuthentication` are the records of architecture 3.15 C. A
handler reads these fields off the context:

| `Session` | Type | | `PendingAuthentication` | Type |
|---|---|---|---|---|
| `id`, `userId` | `string` | | `factorsCompleted` | `readonly AuthenticationFactor[]` |
| `createdAt`, `lastUsedAt` | `Date` | | `availableFactors` | `readonly ("totp" \| "webauthn" \| "recovery")[]` |
| `idleExpiresAt`, `absoluteExpiresAt` | `Date` | | `attemptsRemaining` | `number` |
| `factors` | `readonly AuthenticationFactor[]` | | `expiresAt` | `Date` |
| `ipAddress`, `userAgent` | `string \| null` | | | |
| `isCurrent` | `boolean` | | | |

`AuthenticationFactor` is `"password" \| "totp" \| "webauthn" \| "recovery" \| "oauth"`.
Freshness is measured against `createdAt`, never against `lastUsedAt` (3.5).

### `HttpEnvironment` — what the instance provides

`auth.http` carries everything the handler needs and nothing it does not.

| Field | Type | Meaning |
|---|---|---|
| `routes` | `readonly AnyRoute[]` | The route table, already filtered by identity mode and configuration. |
| `origins` | `readonly string[]` | The allowed origins. An empty list rejects every checked route. |
| `cookieSameSite` | `"lax" \| "strict"` | Which of the two writable attribute sets the cookies carry. There is no third value. |
| `sessionCookieMaximumAgeInSeconds` | `number` | `Max-Age` of the session cookie: a whole number of seconds, at most 400 days. |
| `freshnessWindowInSeconds` | `number` | Measured against `session.createdAt`. |
| `callers` | `CallerResolver` | `resolveSession` and `resolvePending`; both throw, and the error map decides what the caller sees. |
| `rateLimiter` | `RateLimiter` | See below. |
| `clock` | `Clock` | |
| `log` | `(level, message, fields?) => void` | Where the true reason of every concealed failure is written. |

### `createServerMethod(route, environment)` — the direct server call

The same declaration also yields the method the application calls in process:

```ts
const signIn = createServerMethod(signInPasswordRoute, auth.http);

const result = await signIn({
  emailOrUsername: "someone@example.com",
  password,
  origin: "https://app.example.com",
});
```

It runs the same pipeline in the same order as a request — origin check,
address bucket, input parse, caller resolution, handler — because 3.11 puts both
checks in front of the direct call too. Beside the route's own input it takes
five fields, and only these five:

| Field | Type | Meaning |
|---|---|---|
| `origin` | `string \| null` | Required. What an `Origin` header would have carried. `null` is rejected wherever the route declares `originCheck: "checked"`; there is no way to omit the field and skip the check. |
| `sessionToken` | `string?` | What `__Host-velve_session` would have carried; used where the route declares `caller: "session"`. |
| `pendingToken` | `string?` | What `__Host-velve_pending` would have carried; used where the route declares `caller: "pending"`. |
| `ipAddress` | `string \| null?` | Passed to the rate limiter as the scope of the address bucket, unchanged. Absent becomes `null`, and the seam is then obliged to count that request rather than skip it (S-RATE-4); normalising an address to its `/64` prefix is the limiter's work (S-RATE-1), not this layer's. |
| `userAgent` | `string \| null?` | Put on `RequestContext` and nothing else. Whatever stores it is obliged to truncate it by default (L-10); this layer neither stores nor shortens it. |

These five names are reserved: a route declaring an input field of the same name
is a start error, because the envelope would swallow it here and the HTTP path
would keep it.

The method throws where the client returns a result (3.15 E), and it throws
exactly what a request would have answered: a `VelveError` carrying one of the
25 codes, mapped and logged by the same code as the HTTP path. An application
that catches it and forwards `error.code` into its own response publishes
nothing the HTTP answer would not have published.

### The rate limiter seam

`RateLimiter` is the one place a counter hooks into the request chain:

```ts
interface RateLimiter {
  consume(request: {
    routeName: string
    rule: { capacity: number; refillPerSecond: number }   // requests, requests per second
    scope: { kind: "ip_address"; ipAddress: string | null }
         | { kind: "account"; accountIdentifier: string }
  }): Promise<{ allowed: boolean; retryAfterSeconds?: number }>
}
```

`capacity` is a number of requests — the burst a caller may spend at once — and
`refillPerSecond` is how many requests per second flow back into the bucket, so
`{ capacity: 5, refillPerSecond: 0.01 }` is five attempts and then one more
every hundred seconds. An implementation is passed in through
`auth.http.rateLimiter` and needs no change to the HTTP layer. The pipeline consumes the address bucket before the
input is parsed and before the caller is resolved; the route consumes the account
bucket through `context.enforceAccountRateLimit` once it has the identifier,
because the identifier does not exist before parsing. A decision with
`allowed: false` becomes `rate_limited` with the given `retryAfterSeconds`.

The seam is a named field, not a middleware chain: a plugin can neither replace
the origin check nor run before it (3.11).

### Redirects

A handler that must send the caller somewhere returns
`redirectTo(toRedirectPath(path))`, and the response becomes `302` with
`Location: <path>` and no body. `toRedirectPath` is the only way to obtain the
`RedirectPath` that `redirectTo` and `Redirect.redirectToPath` are typed with,
so a redirect target is never a plain string (T-REDIR-1).

It accepts a path and nothing else: no scheme, no host, **no query and no
fragment**, and no character outside the RFC 3986 path set. `//evil.com`,
`https://…`, `javascript:…`, `/app?token=…` and a value carrying `\r\n` all fail
with `internal_error` rather than reaching the header (S-REDIR-3, S-REDIR-4 —
with no query there is nowhere for a token to ride). The full percent-decoding
vector corpus of S-REDIR-2 belongs to the route that accepts a redirect target
from a request, not to this layer, which never accepts one.

`redirectTo(…)` combines with a session token in the same output; the token
still goes into the cookie and never into the `Location` value (S-REDIR-4).

### CORS

**The library sends no CORS headers and answers no preflight**, and this is
deliberate: cross-origin access control belongs in front of the library, in the
reverse proxy or in the application, next to the rest of its HTTP policy. The
same reasoning as architecture 3.14 — the library answers who is signed in, and
nothing else.

The consequence is concrete. If the browser origin and the API origin differ,
every call is cross-origin, and without those headers the browser discards the
answer. Terminate that in front of the process, for example in Traefik:

```yaml
http:
  middlewares:
    velve-auth-cors:
      headers:
        accessControlAllowOriginList: ["https://app.example.com"]
        accessControlAllowCredentials: true
        accessControlAllowMethods: ["GET", "POST", "OPTIONS"]
        accessControlAllowHeaders: ["Content-Type"]
        accessControlMaxAge: 600
```

The origin list there and `origins` in the configuration are separate lists on
purpose: the CORS list decides which page may read an answer, the `origins` list
decides which request is executed at all. Widening the first one never widens
the second.

### Error codes

Every failure carries one of 25 stable codes. The status, the message and the
mapping from internal reason to visible code live in
`src/core/http/error-map.ts`, and no other module decides what a caller sees.

| Code | Status | Code | Status |
|---|---|---|---|
| `invalid_input` | 400 | `factor_not_enrolled` | 409 |
| `origin_not_allowed` | 403 | `factor_already_enrolled` | 409 |
| `rate_limited` | 429 | `last_sign_in_method` | 409 |
| `invalid_credentials` | 401 | `identity_already_linked` | 409 |
| `account_disabled` | 403 | `provider_not_configured` | 400 |
| `session_required` | 401 | `oauth_flow_invalid` | 400 |
| `freshness_required` | 403 | `oauth_provider_error` | 502 |
| `invalid_token` | 400 | `webauthn_challenge_invalid` | 400 |
| `invalid_factor_code` | 401 | `webauthn_credential_rejected` | 401 |
| `invalid_recovery_code` | 401 | `password_unacceptable` | 400 |
| `invalid_pending_authentication` | 401 | `username_taken` | 409 |
| `too_many_factor_attempts` | 429 | `username_invalid` | 400 |
| `internal_error` | 500 | | |

`account_disabled` never appears while signing in — a disabled account is
indistinguishable from a wrong password there (L-4). It appears only when an
existing session is resolved, where the caller has already proved the account is
theirs.

Nine of these codes are merged: several internal reasons produce one code, one
message and one body, and the true reason goes to `log` only. Code throwing a
concealed failure raises `ConcealedError(reason)` and never chooses the visible
code itself.

| Visible code | Internal reasons |
|---|---|
| `invalid_credentials` | `user_not_found`, `password_mismatch`, `no_password_credential`, `legacy_scheme_rejected`, `user_disabled_on_sign_in` |
| `session_required` | `cookie_absent`, `session_not_found`, `session_idle_expired`, `session_absolute_expired` |
| `invalid_token` | `token_not_found`, `token_expired`, `token_consumed`, `token_purpose_mismatch`, `email_taken_on_change`, `user_disabled_on_token_redemption` |
| `invalid_factor_code` | `totp_code_wrong`, `totp_step_replayed`, `totp_not_confirmed` |
| `invalid_recovery_code` | `recovery_code_not_found`, `recovery_codes_exhausted`, `recovery_codes_never_generated` |
| `invalid_pending_authentication` | `pending_not_found`, `pending_expired`, `pending_consumed`, `pending_cookie_absent` |
| `oauth_flow_invalid` | `state_not_found`, `state_expired`, `pkce_mismatch`, `nonce_mismatch`, `issuer_mismatch`, `id_token_signature_invalid`, `user_disabled_on_oauth_flow` |
| `webauthn_challenge_invalid` | `challenge_not_found`, `challenge_expired`, `challenge_purpose_mismatch` |
| `webauthn_credential_rejected` | `credential_unknown`, `signature_invalid`, `rp_id_mismatch`, `origin_mismatch`, `user_not_verified`, `user_disabled_on_webauthn_assertion` |

An exception that is neither a `VelveError` nor a `ConcealedError` becomes
`internal_error` with no detail in the body. The log line for it carries
`reason: "unhandled_exception"` and the exception's own message in a separate
`cause` field, so the 500 is diagnosable from the log alone. A `log` that throws
is swallowed: a failing log sink must not cost the caller its answer.

## Sessions

The library answers one question — who is signed in — and this module is the
only place that answers it. Every answer costs one database query; there is no
cookie cache, no process cache and no parameter that could introduce one
(S-CACHE-1). The most severe published flaw in the comparison system's core
sign-in path was exactly such a cache (CVSS 9.1: the session was cached before
the second factor had been checked).

The module is not on a package subpath yet. It is reached from the instance the
assembling feature builds; the names below are the ones that instance is built
from.

### `createSessionToken()`

```ts
createSessionToken(): { token: SessionToken; tokenHash: Uint8Array }
```

Draws a new session token.

| Field | Type | Meaning |
|---|---|---|
| `token` | `SessionToken` | 32 bytes from `crypto.getRandomValues`, base64url, 43 characters |
| `tokenHash` | `Uint8Array` | `sha256(token)` — 32 bytes, the only form that is stored |

`SessionToken` is a branded `string`, so a value that did not come from here
cannot be passed where a session token is expected without a cast.

The plaintext token leaves the process only in the cookie. `velve.session`
stores `token_sha256` and nothing else, so a database dump contains no usable
session, and no lookup time depends on the plaintext (S-TIM-4).

### `sessionTokenHash(token)`

```ts
sessionTokenHash(token: string): Uint8Array
```

| Parameter | Type | Meaning |
|---|---|---|
| `token` | `string` | the token as it arrives in the cookie |

Returns the 32 bytes stored in `velve.session.token_sha256`. The hash is taken
over the UTF-8 bytes of the token **text**, not over the 32 random bytes it
encodes, so the verifier is computable from the cookie value without decoding
it. A token spelled differently — padded, or in standard base64 — hashes
differently and is simply not found.

### `sessionMetadataFor(mode, observed)`

```ts
sessionMetadataFor(mode: SessionMetadataMode, observed: SessionMetadata): SessionMetadata
```

Decides what `velve.session.ip` and `velve.session.user_agent` are allowed to
hold. `mode` is the top-level configuration option `sessionMetadata`; its
default is `"truncated"` (L-10).

| `mode` | `ip` | `user_agent` |
|---|---|---|
| `"truncated"` (default) | IPv4 to `/24`, IPv6 to `/64` | browser and system family |
| `"full"` | the address as observed | the header, bounded to 512 characters |
| `"none"` | `null` | `null` |

`observed` carries what the request layer saw: `{ ipAddress, userAgent }`, each
`string | null`. The result has the same shape and is what the session row is
written with.

The `/64` for IPv6 is the prefix length the rate limiter uses as well, so an
address never appears in two different truncations. `"203.0.113.0/24"` is
stored with its prefix, so a reader can tell a truncated value from a full one.
An address a proxy wrote as an IPv4-mapped IPv6 address (`::ffff:203.0.113.42`)
is truncated as IPv4; treating it as IPv6 would put every IPv4 client into one
`/64`.

A value that is not an address becomes `null` rather than an error: metadata is
not part of the answer to who is signed in, and a malformed `X-Forwarded-For`
must not cost a user their sign-in.

Truncation happens in the process, before the value is used as a statement
parameter. The full address therefore never reaches the database — not in a
column, and not in a statement a database log might keep.

A user agent that names neither a browser nor a system family becomes `null`;
`"curl/8.7.1"` is stored as nothing rather than as a device fingerprint.

### `session` — the configuration block

```ts
interface SessionConfig {
  idleTimeout: Duration          // "7d"
  absoluteTimeout: Duration      // "30d"
  idleWriteInterval: Duration    // "1h"
  freshnessWindow: Duration      // "15m"
  cookieName: `__Host-${string}` // "__Host-velve_session"
  cookie: { sameSite: "lax" | "strict" }
}
```

| Option | Default | Meaning |
|---|---|---|
| `idleTimeout` | `"7d"` | how long a session survives without being used; extended on use |
| `absoluteTimeout` | `"30d"` | how long a session may live at all; **never** extended |
| `idleWriteInterval` | `"1h"` | how often at most the idle deadline is written back |
| `freshnessWindow` | `"15m"` | how long after sign-in an operation on credentials is allowed |
| `cookieName` | `"__Host-velve_session"` | the session cookie's name |
| `cookie.sameSite` | `"lax"` | the only cookie attribute that is a choice |

`Duration` is a whole number followed by `s`, `m`, `h` or `d`. `"1.5h"`,
`"-7d"`, `"1w"` and `"7"` are refused at startup even though the type admits
some of them; write `"90m"` instead of `"1.5h"`.

`httpOnly`, `secure`, `domain` and `path` are not options. The `__Host-` prefix
forces `Secure` and `Path=/` and forbids `Domain`, which is what rules out
cookie tossing from a subdomain; `sameSite: "none"` is absent for the same
reason. A `cookieName` without the prefix is a type error and, if forced
through, a startup error.

Reading the block also refuses combinations that cannot hold, each with the
name of the option it refused:

- a deadline of zero or less,
- `idleTimeout` longer than `absoluteTimeout` — the idle deadline could never be reached,
- `idleWriteInterval` longer than `idleTimeout` — the deadline would expire before it was ever written,
- `freshnessWindow` longer than `absoluteTimeout` — a session could never stop being fresh.

The session cookie's `Max-Age` is `absoluteTimeout`, so the cookie cannot
outlive the one deadline nothing extends.

`freshnessWindow` is measured against `created_at`, not `last_used_at`:
freshness is time since sign-in, and only a new sign-in restores it.

### `createSessionRepository(options)`

```ts
createSessionRepository(options: { driver: Driver; schema: string }): SessionRepository
```

Every statement the library issues against `velve.session`. All SQL lives here;
nothing above this module writes SQL, and no method takes a table or column name
from a caller.

| Method | Statement | Result |
|---|---|---|
| `insertSession(insert)` | `INSERT … RETURNING …` | the new `Session` |
| `findSessionByTokenHash(hash)` | one `SELECT` joined on `velve.user` | `{ session, userId, userDisabledAt, observedAt }` or `null` |
| `extendIdleDeadline({ sessionId, actor, idleTimeoutMs, writtenNoSoonerThanMs })` | `UPDATE … WHERE id = $1 AND user_id = $2 AND last_used_at <= now() - $4` | the new idle deadline, or `null` if nothing was written |
| `deleteSessionByTokenHash(hash)` | `DELETE … WHERE token_sha256 = $1 RETURNING id, user_id` | what was removed, or `null` |
| `deleteSessionOwnedBy({ sessionId, actor })` | `DELETE … WHERE id = $1 AND user_id = $2` | how many rows went |
| `deleteEverySessionOwnedBy({ actor })` | `DELETE … WHERE user_id = $1` | how many rows went |
| `deleteEveryOtherSessionOwnedBy({ actor, keptSessionId })` | `DELETE … WHERE user_id = $1 AND id <> $2` | how many rows went |
| `listSessionsOwnedBy({ actor, currentSessionId })` | `SELECT … WHERE user_id = $1` and both deadlines in the future | the live sessions, newest first |
| `replaceSession({ previousTokenHash, insert })` | `DELETE` plus `INSERT`, one transaction | the new `Session` |
| `replaceEverySessionOfUser({ actor, insert })` | `DELETE` of every row of the user plus `INSERT`, one transaction | the new `Session` |

`observedAt` is the database's `now()`, read in the same statement as the row.
Everything decided after the fact — whether the idle write is due, whether the
session is still fresh — is measured against it, so no decision compares two
clocks (E-232, E-238).

`SessionInsert` carries `userId`, `tokenHash`, `factors`, `ipAddress`,
`userAgent`, `idleTimeoutMs` and `absoluteTimeoutMs`. Both deadlines are
computed by the database from `now()`, so a session's clock is the database's
clock and not the application's.

Every method that reaches rows by owner takes an `actor` and puts it in the
`WHERE` clause (S-OWNER-1, S-OWNER-2). A row of another user and a row that
never existed produce the same answer (S-OWNER-8).

There is no method that updates `user_id`. `replaceSession` removes the previous
row and inserts a new one in one transaction (S-FIX-1, E-23), and it refuses
with `SessionOwnerMismatchError` if the row it removed belonged to a different
user than the row it is about to write — a re-issue cannot move a session
between accounts even by mistake.

`replaceSession` also refuses, with `PreviousSessionMissingError`, when the
`DELETE` matched no row: a replacement that replaces nothing is an issue, and
issuing is what `insertSession` is for. Two requests re-issuing the same session
at the same moment therefore leave one live session rather than two — the loser's
`DELETE` matches nothing once the winner has committed, and its transaction rolls
back. `SessionService.reissue` turns that refusal into `session_required`,
because a session that vanished mid-flight is a session the caller no longer has.

`replaceEverySessionOfUser` is what a password change uses: it removes **every**
session of the user and issues one new one, in one transaction. There is no
parameter that keeps the others (S-FIX-6).

`listSessionsOwnedBy` lists only sessions that can still be used; an expired row
is not shown to the user as if it were a device that is still signed in. It is
also the only method that sets `Session.isCurrent`, which 3.15 C reserves for
`session.list`; every other method leaves it `false`, including on the session
`resolve` just answered with.

The `Driver` must decode `timestamptz` into a `Date` — `node-postgres`,
`postgres.js` and the neon driver all do. Decoding a PostgreSQL type is the
driver's work; the repository reads values, it does not parse them.

### `createSessionService(options)`

```ts
createSessionService(options: {
  driver: Driver
  schema?: string                                   // "velve"
  session?: Partial<SessionConfig>
  sessionMetadata?: "truncated" | "full" | "none"   // "truncated"
}): SessionService
```

Everything the library does with sessions. **There is no `clock` option, and
passing one is a compile error.** Every moment this module decides by — both
deadlines, the idle write interval and the freshness window — comes from the
database's clock. An option that were accepted and ignored would read like a
seam that is not there: a test that advanced it to age a session would observe
nothing and pass for the wrong reason.

`service.settings` exposes the deadlines the configuration was read into,
including `cookieName` and `cookieMaximumAgeInSeconds` for the cookie writer.

#### Answering who is signed in

| Method | Answer |
|---|---|
| `resolve(token)` | the resolution, or `null` for an unknown or expired token |
| `refresh(token)` | the same, and it forces the idle write the interval would hold back |

`resolve` is the library's only authorisation decision, and it costs exactly one
query. It throws `account_disabled` when the account is disabled — the only
place in the library where that code is raised, because by then the caller has
proved the account is theirs (L-4). An account disabled between two requests
takes effect on the next one; there is no lifetime to wait out (S-CACHE-3).

As a side effect `resolve` extends the idle deadline, at most once per
`idleWriteInterval`. Whether the write is due is decided from the database's own
clock, which the resolving query returns with the row, so no second query and no
comparison between two clocks is needed. `refresh` forces exactly that write and
nothing else: never the absolute deadline, never a new token.

The result of `resolve` is a `SessionResolution`: `{ userId, session,
observedAt }`. It is the only value in the library from which an `Actor` can be
obtained (S-OWNER-7), and it is produced here and nowhere else. `observedAt` is
the database's clock at the moment it answered, and every deadline this module
decides after the fact is measured against it.

#### Issuing and re-issuing

| Method | What it does |
|---|---|
| `issue({ userId, factors, observed })` | a new session — this is a sign-in |
| `reissue({ previousToken, userId, factors, observed })` | a new session, and the previous row goes, in one transaction |
| `reissueAfterCredentialChange({ resolved, factors, observed })` | a new session, and **every** other session of the user goes, in one transaction |

`observed` is `{ ipAddress, userAgent }` as the request layer saw them; what is
stored follows `sessionMetadata` (L-10).

Every event that changes the trust level — sign-in, second factor completed,
password changed, a new identity linked — calls `reissue`, so the token a caller
held before the change is gone from the table and a request carrying it is
answered exactly like a request without a cookie (S-FIX-1, S-FIX-3). A password
change calls `reissueAfterCredentialChange`, which has no parameter that could
keep the other sessions (S-FIX-6).

Re-issue is always an `INSERT` plus a `DELETE`; `UPDATE velve.session SET
user_id` does not exist, and a re-issue whose new row would belong to a
different user than the row it removed is refused (E-23, S-FIX-2).

#### Listing

| Method | Freshness | Answer |
|---|---|---|
| `list({ resolved })` | required | the caller's live sessions, newest first |

`list` is the only place `Session.isCurrent` is set, and it is set by comparing
each row with the session that resolved (3.15 C). Expired rows are not listed:
a session the caller could not use is not a device that is still signed in.

#### Ending sessions

| Method | Freshness | Effect |
|---|---|---|
| `signOut({ token })` | not required | removes the one row the token addresses; an unknown token is not an error |
| `revoke({ resolved, targetSessionId })` | required | removes that session if it belongs to the caller; `void` either way |
| `revokeEveryOther({ resolved })` | required | removes all but the calling session |
| `revokeEvery({ resolved })` | required | removes all, including the calling one |
| `revokeEverySessionOfUser({ actor })` | — | removes every session of that user |

`revoke` answers a session of another user and a session that never existed
identically, and changes nothing in both cases (S-OWNER-4, S-OWNER-8).

`revokeEverySessionOfUser` is what the password **reset** path uses: there is no
surviving session to resolve, so the caller brings the `Actor` its redeemed
one-time token produced. The session module mints no actor for it.

#### Freshness

`isSessionFresh(session, { freshnessWindowMs, now })` answers whether a session
is inside its freshness window; `assertSessionIsFresh` raises
`freshness_required` when it is not.

The window is measured from `created_at`, so it is time since the sign-in.
Nothing but a new session restores it — using the session does not, and neither
does `refresh`. A re-authentication that did not re-issue would be a second
notion of trust standing beside `factors`, and there is only one.

`now` is the database's clock, not the application's: `resolve` returns the
moment the database answered as `observedAt`, and that is what freshness is
measured with. `created_at` and both deadlines are written by the database, so
deciding freshness with a second clock would move the window by whatever skew
lies between them — in the dangerous direction as readily as in the harmless
one. A process clock running an hour behind would keep a fifty-minute-old
session inside a fifteen-minute window, and that window is what guards the
operations on credentials.

For the same reason `createSessionService` takes no clock at all. To age a
session in a test, age it where `created_at` lives — in the database.

Every session operation that reaches rows by owner takes its actor from
`actorOfFreshSession`, which checks freshness before it hands the actor out: an
operation of that group cannot be written without the check.

`reissueAfterCredentialChange` is the exception, deliberately. B.9 puts the
freshness requirement on `password.set` and `password.change`, which is *before*
the password is hashed and written; a check inside the re-issue would run after
it, and failing there would leave the new password in place, the other sessions
alive and the caller without a session — the half state S-FIX-6 exists to
prevent.

### `sessionSettingsOf(config)`

```ts
sessionSettingsOf(config?: Partial<SessionConfig>): SessionSettings
```

Reads the `session` block once, at startup, and produces the numbers everything
else uses: `idleTimeoutMs`, `absoluteTimeoutMs`, `idleWriteIntervalMs`,
`freshnessWindowMs`, `cookieName`, `cookieMaximumAgeInSeconds` and `sameSite`.
An option it refuses raises `InvalidSessionConfigError`, naming the option and
the value it was given.

`createSessionService` calls it; anything that needs a deadline reads the result
rather than parsing a duration again. The HTTP environment's
`freshnessWindowInSeconds` and its session cookie lifetime have to be derived
from the same result, or two windows would be in force at once.
