# @velve/auth — Reference

Every function, parameter, configuration option and table. This file grows with
the implementation; a feature is not finished until it is documented here.

Concepts and rationale are not repeated here — they are in
[`CASE-STUDY.md`](./CASE-STUDY.md). This file states what things do.

Chapters run in dependency order: everything a chapter uses stands above it.
Where two chapters use nothing of each other, the architecture's section order
decides between them, and where that does not either, the wider of the two is
read second.

## Contents

- [Package entry points](#package-entry-points)
- [Schema](#schema)
- [Migrations](#migrations)
- [The driver interface](#the-driver-interface)
- [Repositories](#repositories)
- [Key management](#key-management)
- [HTTP](#http)
- [Rate limiting](#rate-limiting)
- [Passwords](#passwords)
- [Identity](#identity)
- [One-time artefacts](#one-time-artefacts)
- [Sessions](#sessions)
- [TOTP and recovery codes](#totp-and-recovery-codes)
- [WebAuthn](#webauthn)
- [Email flows](#email-flows)
- [OAuth and identity linking](#oauth-and-identity-linking)
- [The instance](#the-instance)
- [Plugins](#plugins)
- [The client](#the-client)

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
import {
  actorOfResolvedSession,
  actorOfRedeemedOneTimeToken,
  actorOfConsumedOAuthFlow,
  type ResolvedSession,
  type RedeemedOneTimeToken,
  type ConsumedOAuthFlow,
} from "@velve/auth";
```

`Actor` is a branded `string`, so a bare string is not one and the mistake does
not compile. There are exactly three producers, one per way of proving who owns
a row, and each takes a nominal type that only one module may assert
(S-OWNER-7, E-93):

| Producer | Evidence | Asserted in |
|---|---|---|
| `actorOfResolvedSession` | `ResolvedSession` — a session the library resolved | `core/session/service.ts` |
| `actorOfRedeemedOneTimeToken` | `RedeemedOneTimeToken` — a row a `DELETE … RETURNING` removed | `core/db/repositories/token.ts` |
| `actorOfConsumedOAuthFlow` | `ConsumedOAuthFlow` — a row of `velve.oauth_flow` the callback consumed | nowhere yet; the feature that consumes a flow asserts it where it removes the row |

A hand-built `{ userId: "…" }` satisfies none of the three, so no handler builds
an actor from a request body, a query string or a header. The three provenances
do not cross either: a consumed flow is not a redeemed token, and neither is a
session.

**What the brand does not do.** It makes minting *visible*, not impossible. A
caller that can issue a session for an arbitrary account can resolve that
session and mint an actor from it in two awaits, with no cast anywhere
(E-341). What rules that out is that issuing a session already implies the
authority the actor would carry — the brand is a review aid, and the entry that
records the path says so rather than claiming more.

### `EntityId`

```ts
import { toEntityId, type EntityId, type UserId } from "@velve/auth";
```

`EntityId<Entity>` is a branded `string` for a `uuid` primary key, with one
alias per table the public surface names: `UserId`, `SessionId`, `IdentityId`,
`WebAuthnCredentialId`, and `ProviderId` for the other half of the
`(provider, subject)` linking key of 3.10. Two aliases are never assignable to
each other, and neither is a `SecretToken`.

That is the second half of S-RAND-6. `SecretToken` already stopped an account
identifier from arriving where a token belongs; `EntityId` stops a token from
arriving where a row identifier belongs. `toEntityId(value)` is the conversion,
and it is deliberately unchecked for the reason `toSecretToken` is (E-260): a
rejected shape would be a second answer beside "no row".

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
| `options.connectionAddress` | `(request: Request) => string \| null` | `() => null` | The address the connection came from. A `Request` carries none, so the adapter supplies it. The handler passes it through `resolveClientAddress` together with `X-Forwarded-For` and the configured `trustedProxies`, so the header counts where — and only where — the configuration says it may (S-RATE-3). Without this option every request shares one bucket per route. |

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

The library sets exactly three cookies, and the set is enumerated in
`src/core/http/cookies.ts` (S-COOKIE-6). A response that would set anything else
fails with `internal_error` rather than being sent.

| Cookie | Lifetime | Attributes |
|---|---|---|
| `__Host-velve_session` | the configured session lifetime | `HttpOnly; Secure; SameSite=Lax; Path=/` |
| `__Host-velve_pending` | 300 seconds | `HttpOnly; Secure; SameSite=Lax; Path=/` |
| `__Host-velve_oauth_state` | 600 seconds | `HttpOnly; Secure; SameSite=Lax; Path=/` |

`SameSite` becomes `Strict` on the first two if the configuration asks for it.
There is no option for `HttpOnly`, `Secure`, `Domain`, `Path` or
`SameSite=None`: the attribute set is a closed union of two string literals, so
no other set can be written down (S-COOKIE-2). The `__Host-` prefix makes the
browser enforce `Secure` and forbid `Domain`, which is what rules out cookie
tossing from a subdomain.

**`sameSite: "strict"` is legal with OAuth configured, and the state pointer
does not follow it.** The provider returns through a top-level cross-site `GET`,
which a `Strict` cookie is not sent on, so a `Strict` pointer would be missing
at the one request that reads it and every callback would answer
`oauth_flow_invalid`. `__Host-velve_oauth_state` therefore keeps `SameSite=Lax`
whatever the session cookie is set to. What secures the callback is the
server-side `state` row in `velve.oauth_flow` and PKCE (3.10), not this
attribute. Its 600 seconds are chosen so the pointer outlives the row it points
at; a pointer that expires first turns a working callback into a refusal.

**The three names are not configurable.** They come from the enumeration in
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
`Max-Age`; and `CookieWriter` is what a handler sees on its context, six
methods named after roles rather than names — `setSession`, `clearSession`,
`setPending`, `clearPending`, `setOAuthState`, `clearOAuthState`.

A request that carries one of these three cookies twice is rejected with
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
| `caller` | `"anonymous" \| "session" \| "pending" \| "server_only"` | Who may call, not what may be read. `session` resolves the session cookie or fails with `session_required`; `pending` resolves `__Host-velve_pending` into the account it names, and only the four routes of 3.6 declare it (S-CACHE-4); `server_only` has no HTTP route and answers 404. |
| `pendingCookie` | `"hidden" \| "readable"` (optional) | Whether the route sees the value of `__Host-velve_pending`, which is a different question from whether it is authorised by it. Absent means `hidden`. `caller: "pending"` implies `readable`, and a declaration that says `hidden` there is refused at definition. A `readable` route with another caller — `GET /pending`, `POST /pending/cancel` — receives `context.pendingToken` and no authority. |
| `freshness` | `"not_required" \| "required"` | `required` needs `caller: "session"` and fails with `freshness_required` outside the freshness window. |
| `originCheck` | `"checked" \| "exempt"` | `exempt` exists for the OAuth callback, which has no `Origin` header by protocol. |
| `rateLimit` | `{ perIpAddress: BucketRule \| "none"; perAccount: BucketRule \| "none" }` | The buckets this route consumes. |
| `handler` | `(input, context) => Promise<Output>` | Returns the output, or nothing for a 204. |

The order in front of the handler is fixed and cannot be reordered by a caller or
a plugin: origin check, per-address rate limit, input parse, caller resolution,
handler.

Five declaration mistakes are start errors rather than request-time surprises: a
path that is not absolute or carries an empty or trailing segment; `freshness:
"required"` without `caller: "session"`; `caller: "pending"` with
`pendingCookie: "hidden"`; an input field named like one of the five
`ServerCallFields`; and, when the handler is built, a route table with a
duplicate name or with two routes answering the same folded path.

`readsPendingCookie(route)` is the predicate behind that field —
`(route: RouteMetadata) => boolean`, true where the declaration resolved to
`pendingCookie: "readable"`, which after `defineRoute` has run includes every
route with `caller: "pending"`. It is not exported from the package; it lives in
`core/http/route.ts` and the pipeline is its only caller, so what a route may see
is decided in one place.

S-CACHE-4 counts **readers**, and `caller` alone no longer bounds them. What
bounds them is a named set in `test/auth-route-table.test.ts`, measured through
that predicate: the four routes of 3.6 that the intermediate state authorises,
plus `pending.read` and `pending.cancel`, which read the cookie and are
authorised by nothing. Six names, and a seventh reader fails that case.

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

The validator constructors live in `core/http` and appear only in route
declarations.

| Constructor | Accepts | Rejects |
|---|---|---|
| `string()` | a string, including `""` | everything else, `null` included |
| `number()` | a finite number | `NaN`, `Infinity`, a numeric string, everything else |
| `oneOf(...values)` | one of the listed strings, narrowed to that literal | any other string, and every non-string |
| `arrayOf(inner)` | an array whose every **own** index `inner` accepts | a non-array, an array with one entry `inner` rejects, and a hole — which is read as `undefined` and offered to `inner` like any other value |
| `unknownRecord()` | any object, contents unread | an array, `null`, and every primitive |
| `optional(inner)` | `undefined`, or whatever `inner` accepts | what `inner` rejects; an explicit `null` is **not** absent |
| `object(shape)` | an object whose declared fields all parse as **own** properties | an array, `null`, a non-object, and — on a `POST` body — any key the shape does not declare |

Every rejection is `invalid_input` with the same message; no validator says
which field was wrong, and no input value is echoed back.

`object()` and `arrayOf()` read own properties only. An inherited property and an
array hole are both absent, and a direct server call can pass either: an object
built with `Object.create`, a sparse array, or a plain object whose class of
input arrives after something has written to `Object.prototype`. Reading through
the chain would let a value the caller never sent arrive as a validated field —
the unknown-key guard cannot stop it, because `Object.keys` lists own keys and so
never sees an inherited one to reject. A JSON body cannot reach this: `JSON.parse`
makes even `__proto__` an own key, which the unknown-key guard rejects.

`object(shape)` nests: a field's validator may itself be an `object()`, which is
how the two WebAuthn ceremony payloads are declared. An absent optional field
leaves **no key** on the parsed value, and its type is `field?: T` rather than
`field: T | undefined`, so a parsed payload is assignable to a foreign type that
declares the field optional. `number()` guards `NaN` and `Infinity` because a
direct server call passes JavaScript values, where a request body could only
carry what JSON can spell.

`unknownRecord()` exists for `clientExtensionResults`: the WebAuthn extension
outputs are open-ended and the library reads none of them (1 D36), so the
shape is checked and the contents are not.

### `RequestContext`

| Field | Type | Meaning |
|---|---|---|
| `session` | `Session \| null` | Set for `caller: "session"`. |
| `pending` | `ResolvedPendingAuthentication \| null` | Set for `caller: "pending"`. It carries `userId`, the `pending` record itself and the `observedAt` the database answered with — a route authorised by the intermediate state has to act on the account it belongs to, which the record alone does not name. |
| `sessionToken` | `string \| null` | The raw cookie value, for routes that answer with `null` instead of failing when no session exists. |
| `pendingToken` | `string \| null` | The raw pending cookie value, and only for a route that declares `pendingCookie: "readable"`. Every other route is answered as if the cookie were absent. |
| `ipAddress` | `string \| null` | The address the rate limiter counts: `options.connectionAddress` resolved against `X-Forwarded-For` and `trustedProxies`. |
| `userAgent` | `string \| null` | From the `User-Agent` header. |
| `cookies` | `CookieWriter` | `setSession`, `clearSession`, `setPending`, `clearPending`, `setOAuthState`, `clearOAuthState` — a role, never a name, so no unenumerated cookie can be written. |
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
| `trustedProxies` | `readonly string[]` | The CIDR ranges whose `X-Forwarded-For` counts. Empty — the default — means the connection address counts and no header can move a bucket (S-RATE-3). |
| `cookieSameSite` | `"lax" \| "strict"` | Which of the two writable attribute sets the cookies carry. There is no third value. |
| `sessionCookieMaximumAgeInSeconds` | `number` | `Max-Age` of the session cookie: a whole number of seconds, at most 400 days. |
| `freshnessWindowInSeconds` | `number` | Measured against `session.createdAt`. |
| `callers` | `CallerResolver` | `resolveSession` returns the `Session`, `resolvePending` the `ResolvedPendingAuthentication`; both throw, and the error map decides what the caller sees. |
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

### Address parsing — `core/net/ip-address.ts`

Two callers need the same address parser with different prefix lengths, so the
parser is a module of its own that belongs to neither. It imports nothing.

| Name | Signature | What it is |
|---|---|---|
| `canonicalIpAddress` | `(text: string) => string \| null` | the address as `inet` will hold it — RFC 5952 for IPv6, unmapped for `::ffff:` — or `null` if the text is not an address |
| `ipAddressNetwork` | `(text: string, prefixLengths: IpAddressPrefixLengths) => string \| null` | the address masked to its family's prefix and written with that prefix, or `null` if the text is not an address |
| `IpAddressPrefixLengths` | `{ ipv4: number; ipv6: number }` | how many leading bits survive, per family |

```ts
ipAddressNetwork("2001:DB8::1", { ipv4: 32, ipv6: 64 })         // "2001:db8::/64"
ipAddressNetwork("::ffff:203.0.113.5", { ipv4: 32, ipv6: 64 })  // "203.0.113.5/32"
ipAddressNetwork("203.0.113.5", { ipv4: 24, ipv6: 64 })         // "203.0.113.0/24"
```

The parse comes before the mask, so the compressed, expanded, upper-case and
IPv4-mapped spellings of one address produce one string. That folding is what
`S-RATE-1` requires of the rate key and what `L-10` requires of the stored
session metadata; only the prefix lengths differ. The rate key uses
`{ ipv4: 32, ipv6: 64 }` — the `/64` prefix rather than the address, or an
attacker rotates freely inside one prefix (CVE-2026-45364), and the **full**
IPv4 address, because a `/24` there would put 254 unrelated hosts in one bucket.
Session metadata uses `{ ipv4: 24, ipv6: 64 }` (L-10) and keeps that choice in
`core/session/ip-address.ts`, which is the only place the `/24` is written down.

Anything that is not exactly one address is `null`, and a header holding two —
`"1.2.3.4, 5.6.7.8"` — is not one address. A zone identifier, a bracketed host,
a leading zero in an octet and a trailing prefix are all rejected rather than
guessed at.

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

## Rate limiting

The rate limiter lives in `src/core/limit`. It is the implementation behind the
`RateLimiter` seam the HTTP chapter declares, and it adds nothing to that
interface: the HTTP layer calls `consume` and reads `allowed`, and everything
below is this module's business.

It is not reachable from a package entry point yet — the wiring belongs to
whoever owns `src/index.ts` — so everything below describes the module as it is
imported from `src/core/limit`, not as `@velve/auth` exports it today.

It keeps three counters, and only two of them can refuse a request.

| Counter | Key | On overflow |
|---|---|---|
| Address | route name and the address prefix | `rate_limited` |
| Account | route name and `HMAC(token-pepper, identifier)` | `rate_limited` |
| Per route, per instance | route name, in memory | an alarm, and nothing else |

### `createRateLimiter(options)`

```ts
import { createRateLimiter } from "../limit/index.js";

const rateLimiter = createRateLimiter({
  driver,
  keys,
  schema: "velve",
  clock: { now: () => new Date() },
  config: {
    routeFlood: {
      rule: { capacity: 500, refillPerSecond: 5 },
      onAlert: (alert) => metrics.increment("velve.route_flood", alert),
    },
  },
});
```

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `driver` | `Driver` | — | The database. Every check is one statement on it. |
| `keys` | `KeyProvider` | — | Where the `token-pepper` key comes from. The account key is an HMAC under it, so no identifier is written down. |
| `schema` | `string` | — | The schema holding `velve.rate_bucket`. Validated as an identifier before it reaches any statement. |
| `clock` | `{ now(): Date }` | — | The instant a check is measured at. It is written into the row and it is what the next check measures elapsed time from. |
| `config.routeFlood` | `{ rule, onAlert }` | absent | The per-route alarm below. Absent means no alarm and no in-memory state. |

It returns a `RateLimiter`. Nothing else about it is public: there is no method
to reset a bucket, none to read one, and none to exempt a caller.

### The statement

One `INSERT … ON CONFLICT … DO UPDATE … RETURNING tokens` per check, which is
architecture 3.9 and is what makes `S-RATE-6` hold. There is no read followed by
a write, and no row lock — `ON CONFLICT DO UPDATE` serialises the conflicting
writers itself, so at *n* simultaneous requests against a capacity of *L*, at
most *L* come back with a non-negative level.

The refilled level is computed inside the statement:

```
level  = LEAST(capacity, GREATEST(0, stored + elapsed × refillPerSecond)) − 1
```

`RETURNING tokens` hands `level` back, and the request is allowed when it is not
negative. Two floors deviate from the SQL printed in 3.9, and both exist for
`S-RATE-7`:

- **The level is floored at zero before the draw.** Without it a refused request
  drives the stored level further negative every time, so a caller who sent a
  million refused requests leaves a bucket that needs a million tokens' worth of
  refilling. The account then stays shut for the rightful owner long after the
  flood stopped, which is the lockout the requirement forbids. With the floor a
  refused bucket rests at −1 and the next success needs two tokens' worth of
  time, whatever happened before.
- **Elapsed time is floored at zero.** The instant comes from `clock`, so two
  instances with skewed clocks would otherwise let the one that is behind
  subtract tokens rather than add them.

`expires_at` is set on every write to the time the bucket needs to fill from
empty — `capacity / refillPerSecond` — with a floor of 60 seconds and a ceiling
of one day. A row swept earlier than that would hand the remaining tokens back
early. The ceiling is not a rounding: a bucket that would take longer than a day
to refill is a lockout with a rate limiter's name on it.

The table itself is `velve.rate_bucket`, created by migration 1 and described in
the schema chapter. This module adds no migration and no table.

### The address counter

The key is the route name and the address prefix: `/64` for IPv6 and the whole
address for IPv4, through `ipAddressNetwork(text, { ipv4: 32, ipv6: 64 })`.

```
ip|signIn.password|2001:db8::/64
ip|signIn.password|203.0.113.5/32
ip|signIn.password|unresolved
```

A thousand addresses inside one `/64` are one bucket (`S-RATE-2`), and the
compressed, expanded, upper-case and IPv4-mapped spellings of one address are
one key (`S-RATE-1`). Surrounding whitespace is trimmed, so `" 203.0.113.5 "`
and `"203.0.113.5"` count together.

**`unresolved` is a real bucket, not a skipped check.** Where the address is
`null`, or is text that is not one address — a zone identifier, `host:port`, a
bracketed address, two addresses in one header value — the request counts on one
shared bucket per route and the limit is enforced there (`S-RATE-4`). Nothing
reaches the handler without being counted. The cost is that unrelated callers
whose address could not be determined share a bucket; the alternative is a free
lane that any caller can enter by sending a header the parser rejects.

The route name in the key is the **resolved** name from the route declaration,
never the request path, so `/sign-in/password`, `//sign-in/password`,
`/sign-in/password/`, `/./sign-in/password`, `/sign-in//password`,
`/sign-in/passw%6Frd` and `/SIGN-IN/PASSWORD` all count on one bucket
(`S-RATE-5`, GHSA-x732-6j76-qmhm). The limiter never sees a path.

### The account counter

The key is the route name and `HMAC-SHA256(token-pepper, normalised identifier)`,
base64url-encoded:

```
account|signIn.password|WwPZ0y5hVZ6t3q8k2m1n4p7r0s3u6w9x2z5A8C1E4G8
```

It is formed before the user is resolved, so an identifier that belongs to an
account and one that belongs to nobody advance the same row and are refused
after the same number of attempts. The identifier never reaches
`velve.rate_bucket` in the clear (`S-RATE-7`, L-5), and the pepper is a key from
the `KeyProvider` rather than a value in the process, so a database dump does
not let the keys be recomputed.

The route passes the identifier through `context.enforceAccountRateLimit` after
it has parsed the input; normalising it is the route's job, not this module's.
Two spellings that normalise to one identifier are one bucket only because the
route normalised them first.

An empty bucket is a refusal with `rate_limited`. It is never a delay and never
a lock. `test/limit-option-shape.test.ts` holds an allowlist of every member
name this module declares, each one read and found to be neither, and it fails
the build on any name that is not on it — so a delay cannot be added without
somebody putting its name on that list first. It is not a filter that recognises
forbidden names, and it was one until it passed `minimumResponseTime` (E-394).
The bucket refills at the configured rate, so an account stays reachable for its
owner with the right credentials after any number of failed attempts by anyone
else.

A refusal is answered without running a key derivation, so it is measurably
cheaper than a failed sign-in. That is the point of ordering the checks this way
and not an accident of the implementation.

### `retryAfterSeconds`

A refusal carries the whole seconds until the bucket holds a token again,
`ceil((1 − level) / refillPerSecond)`, and never less than 1. Where
`refillPerSecond` is zero or not a finite number the field is **absent**: a wait
that never ends is not a wait a caller can act on.

A caller must not read the field's absence as anything more than absence. The
KDF semaphore refuses with the same `rate_limited` code and has never carried a
`Retry-After` (E-166), so two different refusals reach the outside under one
code, and only one of them can say how long.

### The per-route alarm

`config.routeFlood` watches how much traffic one route is taking on this
instance. It refuses nothing (`S-RATE-8`); when its allowance runs out it calls
`onAlert` and the request continues to the ordinary counters.

| Field | Type | Meaning |
|---|---|---|
| `rule.capacity` | `number` | Address checks the route may take before the alarm sounds |
| `rule.refillPerSecond` | `number` | How fast that allowance comes back |
| `onAlert` | `(alert: RouteFloodAlert) => void` | Called on the transition into exhaustion, not on every request past it |

```ts
interface RouteFloodAlert {
  routeName: string
  addressChecksObserved: number   // on this instance, since it started
  observedAt: Date
}
```

Three things about it are worth knowing before it is configured.

- **It counts address checks, not requests.** A route that declares
  `perIpAddress: "none"` is invisible to the alarm, because the pipeline never
  calls the limiter for it. Every route that can be flooded from outside
  declares an address bucket, so in practice one check is one arriving request —
  but the threshold is in checks, and that is what the field is named after.
- **It is per instance and in memory.** Four processes behind one proxy hold
  four independent counters; a threshold meant to describe the whole service has
  to be divided by the number of instances. Nothing is written to the database
  for it.
- **It is refilled from the clock, never by a timer.** A process saturated by
  the very flood the alarm exists to notice does not run its timers — 800
  concurrent sign-ins once produced no timer callback at all in 14.7 seconds
  (E-186) — so a counter whose window is reset on a timer is silent exactly when
  it is needed.

An `onAlert` that throws is swallowed, for the same reason a `log` that throws
is: an alert sink that is down must not cost the caller its answer.

### `resolveClientAddress(connectionAddress, forwardedFor, trustedProxies)`

A pure function. `toWebHandler` calls it on every request with the address
`options.connectionAddress` returned, the request's `X-Forwarded-For` and the
configured `trustedProxies`; it is exported as well, for an adapter that has to
resolve the address before the handler sees the request. It reads no header
itself and holds no state.

| Parameter | Type | Meaning |
|---|---|---|
| `connectionAddress` | `string \| null` | The transport peer, from the adapter |
| `forwardedFor` | `string \| null` | The raw `X-Forwarded-For` value, or `null` |
| `trustedProxies` | `readonly string[]` | Addresses and CIDR ranges whose `X-Forwarded-For` may be believed |

```ts
resolveClientAddress("203.0.113.1", "9.9.9.9", [])                       // "203.0.113.1"
resolveClientAddress("10.0.0.5", "1.2.3.4, 10.0.0.9", ["10.0.0.0/8"])    // "1.2.3.4"
resolveClientAddress("203.0.113.1", "9.9.9.9", ["10.0.0.0/8"])           // "203.0.113.1"
```

The header is read only where `trustedProxies` says who may write it
(`S-RATE-3`). With an empty list, or a connection from an address the list does
not cover, the answer is the connection address and no `X-Forwarded-*` header
can move it. Where the connection is from a trusted proxy, the answer is the
**rightmost** claimed address that is not itself a trusted proxy — the last hop
no trusted party vouched for. Taking the leftmost instead would let any client
prepend an address and choose its own bucket.

An entry that does not parse — `10.0.0.0/`, `10.0.0.0/33`, `not-a-range` —
matches nothing, so a mistyped list falls back to the connection address rather
than trusting a header it cannot check. Nothing reports the typo; validating the
list belongs to whatever accepts it as configuration.

A chain of nothing but trusted proxies, and a `null` connection address, both
answer with the connection address. In the second case that is `null`, which the
address counter turns into the shared `unresolved` bucket rather than a skipped
check.

## Passwords

The password module lives in `src/core/password`. It owns one canonical storage
string per credential, the switch that decides which verifier reads it, the
Argon2id creation path, the semaphore that bounds concurrent key derivation, and
the envelope encryption of the stored string.

It is not reachable from a package entry point yet — the wiring belongs to
whoever owns `src/index.ts` — so everything below describes the module as it is
imported from `src/core/password`, not as `@velve/auth` exports it today.

### The PHC string

A credential is stored as one string in the PHC family (architecture 3.3). No
foreign raw format is ever stored: an import rewrites every source format into
one of these strings before it is written.

| Prefix | Scheme | Created | Verified |
|---|---|---|---|
| `$argon2id$` | Argon2id — the only scheme the library creates | yes | yes |
| `$argon2i$`, `$argon2d$` | other Argon2 variants | no | yes |
| `$2a$`, `$2b$`, `$2y$`, `$2x$` | bcrypt | no | yes |
| `$scrypt$` | scrypt in PHC spelling | no | yes |
| `$pbkdf2-sha256$`, `$pbkdf2-sha512$` | PBKDF2 | no | yes |
| `$fbscrypt$` | Firebase scrypt, in the spelling GoTrue uses | no | yes |

#### `parsePhc(text)`

Reads a PHC string. Returns `null` for anything that is not one — a bcrypt hash
included, since bcrypt is not a PHC string and is dispatched on its prefix
without being parsed.

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | the function identifier, `[a-z0-9-]{1,32}` |
| `version` | `number \| undefined` | the standalone `v=` field, present on Argon2 |
| `parameters` | `ReadonlyMap<string, string>` | the comma-separated list, in the order it appeared |
| `salt` | `Uint8Array \| undefined` | decoded |
| `hash` | `Uint8Array \| undefined` | decoded; absent when the string carries only a salt |

The grammar is read left to right: identifier, then an optional `v=<decimal>`
field, then an optional parameter list, then the salt and the hash. A field is
read as a parameter list only when every pair is well formed **and** at least
one value is non-empty, which is what separates a parameter from a salt that
arrived with base64 padding (E-160). Base64 padding is accepted everywhere it
occurs in an imported value and is never emitted.

#### `formatPhc(value)`

Writes the string back. Round-trips every canonical string byte for byte;
padding an imported value carried in its salt or hash field is normalised away,
because the canonical spelling has none.

#### `integerParameter(value, name)` and `bytesParameter(value, name)`

Read one parameter as a non-negative decimal of at most ten digits, or as
base64-decoded bytes. Both return `null` when the parameter is absent or does
not have that shape; neither substitutes a default. A verifier that cannot read
its own parameters rejects the credential rather than deriving with a guess.

#### `encodeStandardBase64(bytes)` and `decodeStandardBase64(text)`

The PHC alphabet — standard base64, `+` and `/`, no padding on output. Decoding
accepts a padded value and rejects the base64url alphabet, misplaced padding and
non-canonical trailing bits. This is a second base64 implementation next to the
key module's base64url; the reason is in E-161.

### `PasswordConfig`

Everything the module can be told. Every field is optional; the defaults are the
ones architecture 3.3 fixes.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `argon2id` | `{ memoryKiB, iterations, parallelism }` | `{ 19456, 2, 1 }` | the parameters every created hash carries. Raising them is allowed, lowering any one of them is a start error (S-DEFAULT-6) |
| `acceptLegacy` | `readonly LegacyScheme[]` | all seven | which imported schemes are still verified. Naming fewer narrows the estate; naming an unknown scheme is a start error |
| `minimumLength` | `number` | `8` | in characters, counted after NFKC. Below 8 is a start error |
| `maximumLengthInBytes` | `number` | `4096` | in UTF-8 bytes. Above 4096 is a start error; lowering it is allowed |
| `concurrentHashLimit` | `number` | `min(4, cpus)` | how many key derivations may run at once. `1` to `4`; above four is a start error, because S-DOS-3 names `min(4, cpus)` as the bound of the library and not as a starting point (E-188) |
| `validate` | `(plaintext: string) => Promise<void>` | none | the one hook for an application password policy (L-7) |

`LegacyScheme` is `"argon2i" | "argon2d" | "bcrypt" | "scrypt" |
"pbkdf2-sha256" | "pbkdf2-sha512" | "fbscrypt"` — the seven schemes that are
verified but never created. Argon2id is not among them: it is the created one.

There is no option that weakens anything. Every bound is a floor or a ceiling in
the safe direction, so `resolvePasswordConfig` has nothing to log at start-up
(S-DEFAULT-1); a weakening attempt is refused instead of recorded.

#### `resolvePasswordConfig(config?)`

Turns the options into the resolved shape the rest of the module takes, or
throws `PasswordConfigurationError` with one of these codes:
`argon2id_memory_below_floor`, `argon2id_iterations_below_floor`,
`argon2id_parallelism_below_floor`, `minimum_length_below_floor`,
`maximum_length_above_ceiling`, `maximum_length_below_minimum_length`,
`maximum_length_not_an_integer`, `concurrent_hash_limit_out_of_range`,
`legacy_scheme_unknown` — the union `PasswordConfigurationErrorCode`. It is a
start error, never a request error.

`min(4, cpus)` reads `navigator.hardwareConcurrency`. A runtime that does not
report one — Node 20.19 has no `navigator` — gets `1`, because four would
overshoot `min(4, cpus)` on a one- or two-core container. **On Node 20, set
`concurrentHashLimit` explicitly** or the library serialises every sign-in
(E-183).

### The length policy

Length is checked before any key derivation, in three steps that get more
expensive as they go (S-DOS-1, E-164):

1. the UTF-16 code unit count against **four times** `maximumLengthInBytes`.
   This is a bound, not a measurement: NFKC composition can shrink a string, so
   the raw count is not comparable with the byte length of the normal form.
   UAX #15 caps canonical composition at a threefold shrink in UTF-8, so nothing
   that would pass is refused here, and a megabyte-sized input still never
   reaches `normalize` (E-181);
2. NFKC normalisation (NIST SP 800-63B-4 §3.1.1.2), then the character count
   against `minimumLength`;
3. the UTF-8 byte length of the normalised form against `maximumLengthInBytes`,
   because a compatibility character can grow under NFKC.

#### `acceptSubmittedPassword(plaintext, policy)`

The sign-in entry. Returns `{ text, bytes }` — the normalised password and its
UTF-8 encoding — or `null` when the length policy refuses. It takes a
`PasswordPolicy`, which has only the two length fields, so `validate` is not
reachable from the hot path at all (L-7, E-165).

#### `acceptNewPassword(plaintext, config)`

The setting and changing entry. Applies the same length policy, then awaits
`validate`. Throws `VelveError("password_unacceptable")` when either refuses.

`validate` receives the **normalised** password, which is what becomes the
credential. If it throws, the caller learns `password_unacceptable` and nothing
else — the hook's own message goes nowhere (E-163). Its shared message names
only the length limits, which is imprecise for a hook rejection; that is the
price recorded in E-163.

### The KDF semaphore

Argon2id at the default parameters holds 19 MiB for the length of one call, and
an imported `$fbscrypt$` verification holds about 16 MiB. Without a bound, a
sign-in flood multiplies that by the number of concurrent requests and the
process dies of memory instead of refusing requests (architecture 5.18).

#### `createKdfSemaphore({ limit, waitLimitInMilliseconds? })`

| Parameter | Default | Meaning |
|---|---|---|
| `limit` | — | how many derivations may run at once. `resolvePasswordConfig` supplies `min(4, cpus)` |
| `waitLimitInMilliseconds` | `5000` | how long a request may wait for a place before it is refused (L-1, E-13) |

| Member | Meaning |
|---|---|
| `run(work)` | acquires a place, awaits `work()`, releases the place — also when `work` throws |
| `inFlight` | how many derivations are running now |
| `peakInFlight` | the highest value `inFlight` has reached |
| `waiting` | how many requests are queued for a place |

Places are handed out first come, first served. A request that has waited
`waitLimitInMilliseconds` is refused with `VelveError("rate_limited")`, leaves
the queue and never runs its work, so a refusal costs no derivation. It is not
*quick*: it arrives after the full wait limit, five seconds by default, where a
successful sign-in takes about twenty milliseconds. What it costs is nothing,
and what it depends on is load.

This is a resource limit, not a timing equalisation. Nothing about it varies
with the account: a request for an identifier that resolved to an account and
one for an identifier that resolved to nobody wait the same time and are refused
the same way (L-1, S-DOS-4). The semaphore is entered after the credential query
and the decryption, so it is not the thing that keeps those two uniform — that
is `checkPassword`'s single code path. The rate limiter of architecture 3.9 is
what runs before the user is resolved.

The refusal carries no `retryAfterSeconds`: the semaphore knows only that the
queue was full, not when it will empty (E-166). The per-IP and per-account rate
limiters, which do know, set that field themselves.

Verification and the background rehash take places from the **same** semaphore,
which is what stops a rehash wave after a parameter increase from displacing
live sign-ins (S-DOS-6).

### The verification switch

#### `schemeOfStoredHash(phc)`

Reads the scheme off the prefix of a stored value, or `null` when no prefix
matches. Eleven prefixes map onto eight schemes — bcrypt contributes four.
`md5`, `sha1` and every other prefix return `null` and are never verified
(E-39).

#### `verifyAgainstScheme(scheme, password, stored)`

Runs the verifier the scheme names and answers `true` or `false`. It answers
`false` — it does not throw — for every one of these, so that nothing between
step 2 and step 4 of the sequence in 3.3 can leave the path early (S-TIM-1):

- a scheme the table does not name;
- a stored value that is not a PHC string, or not one of the scheme it is filed
  under;
- **an identifier inside the credential that disagrees with the `scheme`
  column** — `acceptLegacy` is applied to the column, which L-2 keeps readable
  without a key, so the column and the credential have to name the same
  function or the policy would gate on one while the verifier acted on the
  other (E-177). An import that writes a mismatched column produces rows that
  never verify; the two write paths refuse to create one (E-187);
- a parameter that is missing, not a decimal, or above a cost ceiling;
- a derivation that refuses its own inputs.

| Scheme | Verified with |
|---|---|
| `argon2id`, `argon2i`, `argon2d` | `@noble/hashes/argon2`, or `hash-wasm` when installed |
| `bcrypt` | `bcryptjs` |
| `scrypt` | `@noble/hashes/scrypt` |
| `pbkdf2-sha256`, `pbkdf2-sha512` | `crypto.subtle.deriveBits`, falling back to `@noble/hashes/pbkdf2` |
| `fbscrypt` | `@noble/hashes/scrypt` and AES-256-CTR |

Every comparison of a derived value runs over equal-length buffers in constant
time. Derived key material carries the branded type `Secret<…>`, which is what
makes "no `===`, `startsWith`, `includes` or `localeCompare` on a secret"
statically checkable (S-TIM-3, E-172).

Details that decide whether an imported estate transfers:

- **A missing `v=` field means Argon2 version 1.0**, as the reference decoder
  reads it — not 1.3 (E-173).
- **`$2x$` is verified as `$2a$`.** `bcryptjs` refuses the revision outright;
  the two differ only in how bytes with the high bit set were handled, so the
  rewrite answers correctly for an ASCII password and cannot produce a false
  accept for any other (E-169).
- **bcrypt proves only the first 72 bytes.** A password longer than that is
  truncated by the algorithm. After the rehash to Argon2id the full length
  counts.
- **`$fbscrypt$` reads `n` as the exponent of `N` and `r` as scrypt's block
  size.** Swapping the two produces no error, only hashes that never match,
  which is why the derivation is tested against the published Firebase
  reference vector (4.4 d, E-171).

### Argon2id creation

#### `createArgon2idHash(passwordBytes, parameters)`

Draws a 16-byte salt, derives 32 bytes and returns the canonical string
`$argon2id$v=19$m=<memoryKiB>,t=<iterations>,p=<parallelism>$<salt>$<hash>`.
The parameters in the string are exactly the configured ones (S-REST-7).

#### `selectArgon2Engine(version)`

`hash-wasm` is an optional peer dependency and an accelerator only. When it is
installed it derives Argon2 about four times faster and its output is
byte-identical, so installing or removing it needs no migration and changes no
security behaviour (S-DEFAULT-7).

One exception, found by measurement: `hash-wasm` accepts a `version` option and
ignores it, computing version 1.3 whichever value it is given. Any version other
than 1.3 therefore stays on `@noble/hashes` (E-168). Since the library only ever
creates version 1.3, this affects imported hashes alone.

The dependency is loaded through a literal `import("hash-wasm")`, so a
dependency or advisory scanner can see that an advisory against the package
reaches this line; `knip.json` exempts it by name instead (E-180, which reversed
E-170).

Because the accelerator computes in one synchronous WebAssembly call, each
accelerated derivation yields a `setTimeout` turn before it starts. Without it a
flood is served in one microtask drain, no timer in the process fires, and
S-DOS-4's wait limit never comes due (E-186).

### The stored credential

`velve.password_credential.phc` holds AES-256-GCM over the canonical PHC string
under the purpose key `password-enc`, with the key version in its own column.
`scheme` stays in the clear, so the estate can be surveyed — how many bcrypt
rows are left, how the rehash is progressing — without a key (L-2, S-REST-5).

The price is stated where it belongs, at the top of the operational
documentation: **losing the key means losing every password.** That is the same
risk class as a pepper.

#### `sealPhc(keys, phc)` and `openPhc(keys, row)`

The only two ways a PHC string crosses the column boundary. `sealPhc` returns
`{ keyVersion, ciphertext }`; `openPhc` reads a row back. There is no write path
that puts a cleartext string into the column, and the import module uses these
same two functions rather than a path of its own (architecture 4.0.3).

`openPhc` throws `KeyError("key_version_unknown")` when the row names a key
version that has left the ring, and `KeyError("authentication_failed")` when the
ciphertext does not authenticate. `checkPassword` does not let either reach the
caller — see `assertStoredKeyVersionsAreKnown` below (E-179).

#### `createPasswordCredentialRepository({ driver, keys, schema? })`

| Method | Statement |
|---|---|
| `findByUserId(userId)` | `SELECT … WHERE user_id = $1` |
| `write({ userId, phc, scheme })` | `INSERT … ON CONFLICT (user_id) DO UPDATE … RETURNING user_id` |
| `replaceIfUnchanged({ userId, previous, phc, scheme })` | `UPDATE … WHERE user_id = $1 AND phc = $5`, returning whether one row changed |

`replaceIfUnchanged` is the compare and swap of 3.3 step 6. What it compares is
the stored **ciphertext**, not the PHC string, so a password the user changed
while a rehash was running is never overwritten by it (L-2, E-11).

Both paths refuse two things before they write. A `scheme` that disagrees with
the identifier of the credential is `CredentialWriteError`
`scheme_does_not_match_credential`: such a row could never verify (E-177,
E-187). And a statement that changed no row is `credential_not_written` —
a conflict predicate that is false does not raise, it silently changes nothing,
and the caller must not be told a password was stored when it was not (E-185).

### Checking a password

#### `createDummyCredential(keys, config)`

Built once at start-up: a real Argon2id hash of a random password, at the
configured parameters, sealed like any other credential. It is what the switch
reads when no user was resolved, so the absent-user path performs the same
decryption and calls the same **verifier** — not the creation function
(S-TIM-2). It is created outside the semaphore, because nothing is being served
yet.

#### `checkPassword({ userId, plaintext }, environment)`

`environment` is `{ config, semaphore, keys, credentials, dummy }`.

`userId` is what the caller's identity lookup produced, or `null` when it
produced nothing. Passing `null` does not shorten the path: the credential query
is still issued, for `ABSENT_USER_ID`, the nil UUID that no account can hold
(E-174).

| Outcome | Meaning |
|---|---|
| `{ outcome: "unacceptable" }` | the length policy refused. Depends on the input alone; no statement and no derivation ran (S-DOS-1, S-DOS-2) |
| `{ outcome: "refused", reason }` | `user_not_found`, `no_password_credential`, `legacy_scheme_rejected` or `password_mismatch` — all four map to `invalid_credentials` for the caller and are told apart only in the log |
| `{ outcome: "verified", userId, rehash? }` | the password matched |

After the length check there is no early exit: one credential query, one
decryption, one verifier call with identical parameters, and the failure
accumulated in a local variable (S-TIM-1). A credential whose scheme is not in
`acceptLegacy` is **still** verified — against the dummy — so that narrowing
`acceptLegacy` does not turn into a timing oracle for which accounts were
imported (E-176).

`rehash` is present when the credential is behind the current policy or the
current key version. It is a **task, not a running promise**: the caller invokes
it after it has sent its answer, so the rehash never lengthens the measured
sign-in (S-TIM-5). It takes a place in the same semaphore as the check, so a
rehash wave after a parameter increase cannot displace live sign-ins (S-DOS-6).
Losing the compare and swap is harmless — it returns `false` and the next
sign-in tries again.

#### `setPassword({ userId, plaintext }, environment)`

Applies the length policy, runs `validate`, derives Argon2id under the
semaphore, and writes the sealed string. Revoking the user's other sessions is
not this module's business; that belongs to the session module and has no switch
(S-DEFAULT-2).

#### `needsRehash(phc, config)`

True when the scheme is not `argon2id`, when the Argon2 version is not 1.3, when
any of `m`, `t` or `p` is below the configured value, when the salt is shorter
than 16 bytes or the hash shorter than 32, or when the string does not parse at
all. An imported credential is therefore rehashed at the first successful
sign-in and verified with its original scheme on every sign-in until then
(S-REST-7).

### What the uniformity rule does and does not cover

The rule from L-1 is that every endpoint has exactly one code path that does the
same work regardless of the outcome. For passwords that means one key derivation
with identical parameters, including against the dummy when no user exists.
There is no response deadline and no artificial delay; the proof is the
statistical test in architecture 6.1, not a number in a configuration.

Two limits are worth stating plainly rather than leaving to be discovered.

**A mixed estate is distinguishable by cost, not by outcome.** An account whose
credential is still an imported bcrypt hash is verified with bcrypt, which costs
far less than the Argon2id the dummy path runs. An observer can therefore learn
that *some* account exists and came from an import — not which password it has,
and not anything about accounts already on Argon2id. This follows directly from
3.3, which verifies each record with its own scheme, and it shrinks to nothing
as the silent rehash works through the estate. Running Argon2id in addition for
every legacy verification would remove the signal at the price of doubling the
cost of exactly the accounts an import made numerous; that trade is not taken.

**A destroyed key version is loud at startup, silent per request.**
`assertStoredKeyVersionsAreKnown` is where an operator learns of it. On the
sign-in path the row simply fails to verify like any other, because a `throw`
there would break S-TIM-1 and would also partition accounts into those written
before a rotation and those written after — an enumeration channel open for the
whole of any rotation window (E-179, superseding E-175).

### Cost ceilings on a stored credential

The memory a verification claims is a parameter of the credential, and an
import writes it. Without a ceiling, S-DOS-3's bound — semaphore size × the
memory parameter — is really semaphore size × the largest value any import ever
wrote. Five fixed ceilings apply, and every scheme the switch verifies is
covered by at least one of them; a credential above
any of them is refused, which routes the user to the reset path (E-182).

| Constant | Value | Applies to |
|---|---|---|
| `MAXIMUM_STORED_MEMORY_KIB` | `65536` | Argon2 `m`, and `128 · 2^ln · r` for scrypt and Firebase scrypt |
| `MAXIMUM_STORED_ARGON2_ITERATIONS` | `64` | Argon2 `t` |
| `MAXIMUM_STORED_PARALLELISM` | `64` | Argon2 and scrypt `p` |
| `MAXIMUM_STORED_PBKDF2_ITERATIONS` | `2_000_000` | PBKDF2 `i` |
| `MAXIMUM_STORED_BCRYPT_COST` | `14` | the cost field of a bcrypt hash |

bcrypt has no memory parameter, so its cost — an exponent — is the only bound
there is: `$2a$14$` is about a second of one semaphore place and `$2a$31$` is
about thirty years. GoTrue, Auth0 and Clerk all write cost 10, which says the
ceiling is generous; it does not say what admitting 14 costs. That is an
occupancy figure, and it was measured rather than estimated.

A cost-14 verification takes about 780 ms on the machine this was written on —
roughly 43× a default Argon2id verification with the accelerator present, and
roughly 9× without it. Raising `concurrentHashLimit` to 4 does not divide that
by four: `bcryptjs` is JavaScript on the same thread as the rest of the process,
so four verifications in flight take four times the wall clock of one. An estate
stored at bcrypt-14 therefore answers about 1.3 sign-ins per second in total,
against roughly 55 for the Argon2id the library writes itself. Read against
S-DOS-3 and S-DOS-4, that is the whole judgement: four places bound the memory,
but at cost 14 they bound nothing about time, and the five-second wait limit —
not the semaphore — is what keeps the process answering, by refusing everything
past a queue of about six.

They are not configurable. Raising a denial-of-service ceiling is a weakening,
and every documented source sits far below them: Better Auth's scrypt at 32 MiB,
Firebase at 16 MiB, Django's PBKDF2 at 1.2 million iterations.
`argon2CostIsAcceptable`, `scryptCostIsAcceptable`, `pbkdf2CostIsAcceptable` and
`bcryptCostIsAcceptable` are the four predicates that apply them.

### Startup

#### `assertStoredKeyVersionsAreKnown({ driver, keys, schema? })`

Reads `SELECT DISTINCT key_version FROM velve.password_credential` and holds
each value against the `password-enc` ring. Throws `PasswordKeyRingError` —
`code: "stored_key_version_unknown"`, `missingVersions: readonly number[]` —
naming every version the ring no longer holds.

**Call this once at assembly, before the instance serves anything.** L-2 makes
the key ring a precondition for every stored password, so a version that has
left the ring locks out everyone whose row was written under it. This is the
only place that says so: on the sign-in path such a row fails to verify like any
other, because a throw there would break S-TIM-1 and would partition accounts
by when they were written (E-179).

The check is exported rather than wired in, because assembling the instance is
not this module's business. Until a caller invokes it, the operator error is
silent.

### Every exported name

`src/core/password` is not reachable from a package entry point yet; the wiring
belongs to whoever owns `src/index.ts`. This is the full surface a caller sees
once it is.

| Name | Kind | File |
|---|---|---|
| `parsePhc`, `formatPhc`, `integerParameter`, `bytesParameter` | function | `phc.ts` |
| `PhcString` | interface | `phc.ts` |
| `encodeStandardBase64`, `decodeStandardBase64` | function | `base64.ts` |
| `PasswordConfig`, `ResolvedPasswordConfig`, `PasswordPolicy`, `Argon2idParameters` | interface | `config.ts` |
| `resolvePasswordConfig` | function | `config.ts` |
| `ARGON2ID_FLOOR`, `ARGON2ID_SALT_BYTES`, `ARGON2ID_HASH_BYTES`, `ARGON2ID_VERSION`, `MINIMUM_LENGTH_FLOOR`, `MAXIMUM_LENGTH_CEILING_IN_BYTES`, `CONCURRENT_HASH_LIMIT_CEILING` | const | `config.ts` |
| `PasswordConfigurationError`, `PasswordConfigurationErrorCode` | class, type | `errors.ts` |
| `CredentialWriteError`, `CredentialWriteErrorCode` | class, type | `errors.ts` |
| `PasswordScheme`, `LegacyScheme` | type | `scheme.ts` |
| `LEGACY_SCHEMES`, `CREATED_SCHEME` | const | `scheme.ts` |
| `schemeOfStoredHash`, `isLegacyScheme` | function | `scheme.ts` |
| `AcceptedPassword` | interface | `policy.ts` |
| `acceptSubmittedPassword`, `acceptNewPassword` | function | `policy.ts` |
| `KdfSemaphore`, `KdfSemaphoreOptions` | interface | `semaphore.ts` |
| `createKdfSemaphore`, `DEFAULT_WAIT_LIMIT_IN_MILLISECONDS` | function, const | `semaphore.ts` |
| `Secret`, `DerivedKey` | type | `secret.ts` |
| `asDerivedKey`, `derivedKeysAreEqual` | function | `secret.ts` |
| `Argon2Variant` | type | `argon2.ts` |
| `Argon2Request`, `Argon2Engine` | interface | `argon2.ts` |
| `nobleArgon2` | const | `argon2.ts` |
| `selectArgon2Engine`, `deriveArgon2`, `createArgon2idHash` | function | `argon2.ts` |
| `verifyArgon2`, `verifyBcrypt`, `verifyScrypt`, `verifyPbkdf2`, `verifyFirebaseScrypt` | function | `verifiers/` |
| `deriveScrypt` | function | `verifiers/scrypt.ts` |
| `verifyAgainstScheme` | function | `verify-switch.ts` |
| `MAXIMUM_STORED_MEMORY_KIB`, `MAXIMUM_STORED_ARGON2_ITERATIONS`, `MAXIMUM_STORED_PARALLELISM`, `MAXIMUM_STORED_PBKDF2_ITERATIONS`, `MAXIMUM_STORED_BCRYPT_COST` | const | `limits.ts` |
| `argon2CostIsAcceptable`, `scryptCostIsAcceptable`, `pbkdf2CostIsAcceptable`, `bcryptCostIsAcceptable` | function | `limits.ts` |
| `PasswordCredentialRow`, `SealedPhc`, `PasswordCredentialRepository`, `PasswordCredentialRepositoryOptions` | interface | `credential.ts` |
| `PASSWORD_ENC_PURPOSE`, `PASSWORD_CREDENTIAL_SCHEMA`, `PASSWORD_CREDENTIAL_TABLE` | const | `credential.ts` |
| `sealPhc`, `openPhc`, `createPasswordCredentialRepository` | function | `credential.ts` |
| `needsRehash`, `needsRewrite` | function | `rehash.ts` |
| `DummyCredential`, `PasswordEnvironment` | interface | `verify.ts` |
| `PasswordCheck` | type | `verify.ts` |
| `ABSENT_USER_ID` | const | `verify.ts` |
| `createDummyCredential`, `checkPassword`, `setPassword` | function | `verify.ts` |
| `PasswordKeyRingError`, `StoredKeyVersionCheckOptions` | class, interface | `startup.ts` |
| `assertStoredKeyVersionsAreKnown` | function | `startup.ts` |

`needsRewrite(row, phc, currentKeyVersion, config)` is `needsRehash` plus the
key version: it is what `checkPassword` calls, so key rotation travels the same
compare-and-swap path as a parameter increase (L-2).

`deriveArgon2` and `deriveScrypt` are the two derivations a verifier calls;
`nobleArgon2` is the pure engine, named so that a test can compare the
accelerator against it. `DerivedKey` is `Secret<"derived-key">`, the branded
type that makes S-TIM-3 checkable; `asDerivedKey` mints one and
`derivedKeysAreEqual` is the only thing that compares two.

## Identity

Which sign-in names an instance has, how they are normalised, which columns of
`velve.user` a new row may carry, how an identifier is turned back into an
account, and how many ways into an account are left.

Nothing in this section reads or writes a session. `findUserByIdentifier` and
`usernameAvailability` take a `Driver`; `countSignInMethods` and
`removeSignInMethod` additionally take the `Actor` that session
resolution produced.

### The three configurations

| Mode | Sign-in name | Unique on | Reset and confirmation over |
|---|---|---|---|
| `email` | the address | `email` | email |
| `username` | the username | `username_key` | recovery codes only |
| `username_email` | username **or** address | both | email |

The mode is chosen once, at initialisation. It decides which `CHECK` migration 2
installs on `velve.user`, so changing it later is a migration and not a setting.

**There is no reset by email in the `username` mode**, because there is no
mailbox to send to. A user who forgets a password with no recovery codes has
lost the account, so the specification makes `identity: { mode: "username" }`
without `recoveryCodes` refuse to start, and a compile error before that, via a
`RecoveryCodesRequirement<Mode>` on the instance options (architecture 3.4 and
3.15 A.3, E-18). **Neither is built yet.** Both belong to the options type of
`createVelveAuth`, which no feature has written; `core/identity` sees a mode, not
the instance options, and cannot state a requirement about `recoveryCodes` from
there. Until the feature that builds `createVelveAuth` carries it, choosing
`username` without issuing recovery codes at registration is a mistake the
library does not catch. This is a recorded hand-off, not an oversight (E-207).

```ts
type IdentityConfiguration<Mode extends IdentityMode = IdentityMode>
```

Without a type argument this is the union of all three; with one it is that
member alone. The member for `email` has no `username` property and will not
accept one, the other two require it — the combination "email mode with username
rules" cannot be written down (E-15).

```ts
type IdentityConfigurationInput<Mode extends IdentityMode = IdentityMode>
```

The same three shapes, but with `username` optional and every rule inside it
optional. This is what a caller writes; `resolveIdentityConfiguration` turns it
into an `IdentityConfiguration`.

#### `resolveIdentityConfiguration(input)`

```ts
resolveIdentityConfiguration({ mode: "username_email" })
// { mode: "username_email", username: DEFAULT_USERNAME_RULES }
```

| Parameter | Type | Meaning |
|---|---|---|
| `input.mode` | `"email" \| "username" \| "username_email"` | which sign-in names exist |
| `input.username` | `Partial<UsernameRules>` | overrides; absent rules take their default. Not accepted in the `email` mode |

Returns the configuration with every rule filled in and every reserved name
already in its comparison form. Throws `IdentityConfigurationError` — a start
error, not a request error — when a rule cannot work:

- `allowedCharacters` can match less than a whole name. That is any of: no
  leading `^` or no trailing `$`; a `^` or `$` anywhere else; or a top-level
  alternation, because `/^[a-z]+|[0-9]+$/` anchors one branch and leaves the
  other free to match anywhere. A pattern that matches part of a name accepts
  the rest of it unexamined.
- `allowedCharacters` carries the `g`, `y` or `m` flag. `g` and `y` keep
  `lastIndex` between calls, so the same name is accepted and refused in turn.
  `m` turns `^` and `$` into line anchors, so `/^[a-z0-9_-]+$/m` accepts
  `alice\n***evil` — and a newline in the middle of a name is not something
  `trim()` reaches.
- `minimumLength` is not a whole number of at least 1.
- `maximumLength` is not a whole number of at least `minimumLength`.

`IdentityConfigurationError` carries `code === "invalid_identity_configuration"`.
It is thrown while the instance is being built and never in answer to a request.

### `UsernameRules` and the character allowlist

```ts
interface UsernameRules {
  allowedCharacters: RegExp        // default /^[a-z0-9_-]+$/
  minimumLength: number            // default 3
  maximumLength: number            // default 32
  reservedNames: readonly string[] // default []
}
```

`DEFAULT_USERNAME_RULES` holds exactly those values.

**Which usernames are accepted by default.** Lowercase `a`–`z`, the digits `0`–`9`,
the underscore and the hyphen, three to thirty-two characters, and nothing else.
Uppercase letters are accepted and kept: the allowlist is applied to the
comparison form, which is the input folded to NFKC and lowercased, so `Alice` is
accepted, is stored as `Alice`, and collides with `alice`.

Everything else is refused. That includes every accented Latin letter, every
non-Latin script, the full stop, the space, the at sign, and every invisible
character — zero-width joiners, soft hyphens, bidirectional overrides. This is
deliberate and it is the homoglyph defence: a name that cannot be spelled cannot
be made to look like another one (E-17). Compatibility spellings are collapsed
before the check, so a full-width `ＡＬＩＣＥ` and a name spelled with the Kelvin
sign U+212A do not survive as separate names — they become `alice` and, for a
name of that one character, `k`.

**Widening it.** `allowedCharacters` is a configuration option, and widening it
is a decision with consequences a caller should take on deliberately.

*What the library does hold.* The comparison form the library produces is its own
fixpoint: folding it again changes nothing, so the key written and the key looked
up are the same value on any database. Folding one code point at a time is what
buys that: lowercasing a whole string applies Final_Sigma, and the `οδος` it
produces is not a form `lower()` would ever produce.

Whether that form is also its own `lower()` in PostgreSQL depends on the Unicode
data the two engines carry, and they are versioned apart. Where they disagree the
schema CHECK refuses the row, so a form the two read differently cannot be
stored — that is the property `test/identity-fold-agreement.test.ts` asserts,
against whatever database it is run on. The size of the disagreement is measured
rather than promised: against PostgreSQL 18.3 a sweep of 1,106,398 comparison
forms finds exactly one, U+038D, an unassigned slot that the C library folds to
`ύ` and JavaScript, correctly, leaves alone; against the PostgreSQL 16 that CI
runs, it finds none. Run the sweep against the database you will actually run to
learn your own number (E-212).

*What that is not.* It is not a claim that two names PostgreSQL considers equal
become one account. `lower('İstanbul') = lower('istanbul')` is true in
PostgreSQL — its `lower()` drops the combining dot, the library's fold keeps it
— and under an allowlist admitting `\p{M}` those are two keys and two accounts.
The library's uniqueness is over the exact bytes of `username_key`, not over
PostgreSQL's notion of equal names, and no allowlist wider than ASCII should be
chosen without checking which pairs that leaves apart.

*What it cannot hold.* Nothing here is a guarantee about a character that
JavaScript and your PostgreSQL disagree on because they carry different Unicode
versions. `username_key = lower(username_key)` is a thin net for that, not a
safety net: it asserts only that the stored form is already its own `lower()`,
and where two sides of a disagreement both satisfy that it says nothing. It does
fire wherever the two engines disagree — an insert of such a comparison form is
refused with SQLSTATE 23514 — but which inputs those are is a property of your
database and not of this library. A different Unicode version on either side
moves that set without warning, so test a widened allowlist against the database
you will actually run.

*And the reason the default is what it is.* Every pair of characters a wider
list admits that a reader cannot tell apart is a name one user can wear in place
of another. The default admits 1294 code points and gives every one of them a
plain ASCII display form; a wider list gives that up.

`reservedNames` are compared against the comparison form and are stored in it, so
`"Admin"` and `"ＡＤＭＩＮ"` both reserve `admin`. A reserved name that the
allowlist cannot spell is unreachable rather than an error.

`minimumLength` and `maximumLength` count code points. The upper bound is
checked against the NFKC form before `allowedCharacters` runs, because that
pattern is the caller's and an unbounded input is work an unauthenticated
request could ask for; it is checked again against the comparison form, because
folding can lengthen a name.

### The exported names

Every name a caller of this module imports. The option bags are plain objects;
the result types are what the functions return.

| Name | Kind | Used by |
|---|---|---|
| `caseFolded` | function | `comparisonFormOf`, both normalisers |
| `codePointCount` | function | `normaliseUsername`, the length bounds |
| `comparisonFormOf` | function | `reservedNames`, the username key column |
| `IdentityConfiguration<Mode>` | result | everything in this section |
| `IdentityConfigurationInput<Mode>` | option bag | `resolveIdentityConfiguration` |
| `UsernameRules` | option bag | `normaliseUsername`, `usernameAvailability` |
| `IdentityConfigurationError` | error class | `resolveIdentityConfiguration` |
| `Normalisation<Value, Rejection>` | result | both normalisers |
| `EmailRejection`, `UsernameRejection` | result | both normalisers |
| `NormalisedUsername` | result | `normaliseUsername` |
| `IdentifierKind` | result | `REQUIRED_IDENTIFIERS`, `IdentifierRejection` |
| `IdentityColumns` | result | `identityColumns` |
| `ProvidedIdentifiers` | option bag | `identityColumns` |
| `IdentifierRejection` | result | `identityColumns` |
| `UserLookup` | option bag | `findUserByIdentifier` |
| `ResolvedUserIdentity` | result | `findUserByIdentifier` |
| `UsernameLookup` | option bag | `usernameAvailability` |
| `UsernameAvailability` | result | `usernameAvailability` |
| `SignInMethodQuery` | option bag | `countSignInMethods` |
| `SignInMethodRemovalRequest` | option bag | `removeSignInMethod` |
| `SignInMethodCount` | result | `countSignInMethods`, `totalSignInMethods` |
| `SignInMethodRemoval` | option bag | both of the above |

`IdentityMode` is not one of them: it comes from the migration that materialises
it, `src/core/db/migrations/identity-mode.ts` (E-190).

### The comparison form

Three exported functions build the form under which usernames and addresses are
compared and stored. Both normalisers, the reserved-name list and the username
key column all pass through them, so no two comparison forms in this module can
disagree.

#### `caseFolded(value)`

Lowercases `value` one code point at a time and joins the result. Per code point
there is no context for the Final_Sigma rule to apply, so `ΟΔΟΣ` folds to `οδοσ`
— what PostgreSQL's `lower()` produces. Lowercasing the whole string at once
would give `οδος` instead, a form `lower()` never produces, and under a widened
allowlist the two spellings would become two accounts.

#### `codePointCount(value)`

The length of `value` in code points rather than UTF-16 code units.
`minimumLength` and `maximumLength` are measured with it, so a character outside
the basic plane counts once and not twice.

#### `comparisonFormOf(name)`

Trims, normalises to NFKC, then applies `caseFolded`. `resolveIdentityConfiguration`
folds every `reservedNames` entry through it, which is why `"Admin"` and
`"ＡＤＭＩＮ"` both reserve `admin`. `normaliseUsername` takes the same three steps
in the same order to produce the username key it stores, so for any input the two
agree — a reserved name is compared against a key built the same way.

A caller that needs to know the form a name will be compared under — to
pre-compute a `reservedNames` entry, or to query the key column directly — calls
this rather than reimplementing the three steps, since reimplementing them is how
the two forms come apart.

### Normalisation

```ts
type Normalisation<Value, Rejection> =
  | { accepted: true; value: Value }
  | { accepted: false; rejection: Rejection }
```

Both normalisers return this shape. Neither throws and neither chooses an error
code: the caller decides whether a rejection becomes `invalid_input`,
`username_invalid` or a `reason` in an availability answer.

#### `normaliseEmail(candidate)`

Trims, folds to NFKC, folds case one code point at a time, and then checks that
the result is structurally one address: exactly one `@`, a non-empty part on each
side, no control, formatting or separating character anywhere, and at most 254
bytes of UTF-8 (RFC 5321). Returns `Normalisation<string, EmailRejection>`.

| `EmailRejection` | Meaning |
|---|---|
| `"malformed"` | not one address, or carrying an invisible or separating character |
| `"too_long"` | more than 254 bytes after normalising |

There is no syntax rule beyond that, and no list of accepted domains. The
library does not decide whether an address exists; a confirmation link does.

#### `normaliseUsername(candidate, rules)`

Trims and folds to NFKC — that is the display form — then folds case one code
point at a time — that is the comparison form. Returns
`Normalisation<NormalisedUsername, UsernameRejection>`.

Case is folded per code point rather than over the whole string because
lowercasing a whole string applies the Final_Sigma rule: `ΟΔΟΣ` would become
`οδος` where PostgreSQL's `lower()` gives `οδοσ`, and under a widened allowlist
the two spellings would become two accounts.

```ts
interface NormalisedUsername {
  username: string     // velve.user.username — the display form
  usernameKey: string  // velve.user.username_key — the comparison form
}
```

The two go into the database together; `user_username_pairing` refuses a row that
carries one without the other.

| `UsernameRejection` | Meaning |
|---|---|
| `"invalid_characters"` | the comparison form is outside `allowedCharacters` |
| `"too_short"` | fewer than `minimumLength` code points |
| `"too_long"` | more than `maximumLength` code points |
| `"reserved"` | the comparison form is in `reservedNames` |

The order is: `too_long` first, against the NFKC form, so the caller's own
pattern never runs on an unbounded input; then `invalid_characters`; then
`too_short`; then `reserved`. Characters are judged before the lower bound, so a
one-character wildcard is reported as `invalid_characters` and not as
`too_short`. No rejection reveals more than the input already did.

### The columns a configuration may write

```ts
const REQUIRED_IDENTIFIERS: Record<IdentityMode, readonly IdentifierKind[]>
// email          -> ["email"]
// username       -> ["username"]
// username_email -> ["email", "username"]
```

This is the runtime statement of the `CHECK` that migration 2 installs. The two
are kept in step by a test that reads the required identifiers out of the shipped
migration's own SQL and then proves against a live database that nothing
`identityColumns` accepts is a row the constraint refuses.

#### `identityColumns(configuration, provided)`

```ts
identityColumns(configuration, { email: "Alice@Example.com", username: "Alice" })
// { accepted: true, value: { email: "alice@example.com", username: "Alice", usernameKey: "alice" } }
```

| Parameter | Type | Meaning |
|---|---|---|
| `configuration` | `IdentityConfiguration` | decides what is required and what is allowed |
| `provided.email` | `string \| null \| undefined` | the address as entered, or as a provider reported it. `null` and absent mean the same: none was reported |
| `provided.username` | `string \| null \| undefined` | the username as entered |

Returns `Normalisation<IdentityColumns, IdentifierRejection>`.

```ts
type IdentityColumns = { email: string | null } & (
  | { username: string; usernameKey: string }
  | { username: null;   usernameKey: null }
)

interface IdentifierRejection {
  identifier: "email" | "username"
  rejection: EmailRejection | UsernameRejection | "required" | "not_configured"
}
```

`"required"` means the mode insists on that identifier and none was given.
`"not_configured"` means a username was given in the `email` mode, where there
are no rules to normalise it against. The address is judged before the username,
so a call that gets both wrong reports the address.

**No address is ever invented.** Where a provider reports none, `email` stays
`null` in the `username` mode, and the call is rejected with `"required"` in the
`email` and `username_email` modes. Real providers report a missing address as
an empty string as often as they omit the field; `""` is `"malformed"`, which
fails the whole call rather than the address alone, so a caller that means "no
address was reported" should pass `null` and not the provider's `""`. There is no fallback, no placeholder domain
and no address derived from an identifier — an invalid address in the table is
worse than no address, because everything downstream takes it for a real one
(E-16, S-LINK-5). A test scans the whole library for the three shapes such an
address is usually built in.

### Resolving an identifier

#### `findUserByIdentifier(lookup)`

```ts
await findUserByIdentifier({ driver, schema, configuration, identifier: "Alice" })
```

| Parameter | Type | Meaning |
|---|---|---|
| `driver` | `Driver` | any driver or the transaction in hand |
| `schema` | `string` | the schema the tables live in |
| `configuration` | `IdentityConfiguration` | decides which columns the identifier is compared against |
| `identifier` | `string` | whatever the caller typed |

Returns `ResolvedUserIdentity | null`.

```ts
interface ResolvedUserIdentity {
  id: string
  email: string | null
  username: string | null
  emailVerified: boolean
  disabled: boolean
}
```

The two timestamps arrive as booleans on purpose: the driver is a parameter, and
whether `timestamptz` reaches JavaScript as a `Date` or as a string is the
driver's decision, not the library's. A caller that needs the moment reads the
column itself.

`disabled` is for the caller that has already proved the account is theirs.
A sign-in path must not act on it: a disabled account answers a sign-in exactly
as a wrong password does (L-4).

**One statement, always.** The identifier is normalised as an address and as a
username — whichever the mode configures — and then the same query runs with the
same two parameters whatever came out. An identifier the allowlist refuses, an
empty string and an address that names nobody all cost the same round trip as one
that names an account, and no branch is taken before the answer is in. That is
what keeps normalisation from becoming the enumeration oracle the rest of the
library avoids (S-ENUM-1, E-46).

The statement orders its results rather than leaving the choice to the planner.
Under the default allowlist no identifier can match both columns, because `@` is
not a username character; under an allowlist wide enough to admit it, one
identifier can name one account by address and another by username. The address
wins over the username, and the older row over the newer.

#### `usernameAvailability(lookup)`

```ts
await usernameAvailability({ driver, schema, rules, candidate: "alice" })
// { available: false, reason: "taken" }
```

| Parameter | Type | Meaning |
|---|---|---|
| `driver` | `Driver` | any driver |
| `schema` | `string` | the schema the tables live in |
| `rules` | `UsernameRules` | the rules the candidate is judged by |
| `candidate` | `string` | the name as typed |

Returns `{ available: boolean; reason?: UsernameRejection \| "taken" }` and
nothing else — no near matches, no prefix search, no count.

**Usernames are enumerable, and this endpoint is how.** An availability check
tells the asker whether a name is in use, and no amount of care changes that.
The library offers the check, says so here, and leaves the hard per-address limit
to the route that exposes it (S-ENUM-8). In the `email` mode there is no
equivalent for addresses and no endpoint whose answer depends on whether an
address exists.

Unlike `findUserByIdentifier` this call does not reach the database when the
spelling already fails: there is nothing to conceal from an asker who is being
told about existence anyway.

### The last sign-in method

A user always keeps at least one of a password credential, a WebAuthn credential
and a linked identity. Removing the last one is refused with
`last_sign_in_method` (L-13). A confirmed address does not count, although a
magic link works with it, and recovery codes do not count: they are a second
factor, not a sign-in name.

This is the count the WebAuthn credential removal and the identity unlinking
will share; neither of those features is built yet.

```ts
interface SignInMethodCount {
  password: number            // 0 or 1
  webauthnCredentials: number
  linkedIdentities: number
}

type SignInMethodRemoval =
  | { method: "password" }
  | { method: "webauthn_credential"; credentialId: string }
  | { method: "linked_identity"; identityId: string }
```

#### `countSignInMethods(query)`

| Parameter | Type | Meaning |
|---|---|---|
| `driver` | `Driver` | any driver or the transaction in hand |
| `schema` | `string` | the schema the tables live in |
| `actor` | `Actor` | the account, from `actorOfResolvedSession` |
| `excluding` | `SignInMethodRemoval` (optional) | a row to leave out of the count |

One statement. `excluding` names a row by its identifier rather than subtracting
one, so a credential that is already gone, or that belongs to somebody else, does
not make the count too low.

#### `totalSignInMethods(count)`

Adds the three numbers. `totalSignInMethods(await countSignInMethods({ ..., excluding }))`
is what would be left after that removal.

#### `removeSignInMethod(request)`

Removes the named sign-in method unless it is the last one. This is the whole
operation, not a check to run before your own `DELETE`.

| Parameter | Type | Meaning |
|---|---|---|
| `driver` | `Driver` | a driver, or the transaction the caller already holds |
| `schema` | `string` | the schema the tables live in |
| `actor` | `Actor` | the account, from `actorOfResolvedSession` |
| `removing` | `SignInMethodRemoval` | which sign-in method to remove |

Returns nothing. Throws `VelveError("last_sign_in_method")` — HTTP 409 — when the
account would be left with no way in, and then nothing is removed.

It does not report whether a row was actually deleted. A `credentialId` that is
already gone, or that belongs to another account, is excluded from the count by
its identifier rather than by subtracting one, so it never makes the count too
low; the delete then matches nothing and the call returns. A caller that needs
to tell "removed" from "there was nothing to remove" reads the row first.

```ts
await removeSignInMethod({
  driver,
  schema,
  actor,
  removing: { method: "webauthn_credential", credentialId },
});
```

The row is deleted with `user_id = actor` in its `WHERE`, so a credential that
belongs to somebody else is never removed and never counted.

**Why the removal is inside the call.** The check and the removal cannot be
separated. Between a caller's check and a caller's `DELETE` there is room for a
second removal to check, see the way in that the first is about to delete, and
delete its own — and the account ends with none, with no error raised anywhere.
The call therefore takes `SELECT … FOR UPDATE` on the user row, counts what
would remain, and deletes, in that order. The locking statement declares what it
takes in a trailing `/* locks: … */` comment, and `pnpm check:lock-order` reads
it. What that check guarantees is narrow: that a row-locking statement carries a
declaration at all, and that the table the declaration names is `user`. It does
not compare the declaration against the `FROM` clause. The schema is interpolated
from the same `request.schema` the table name is built from, so the two cannot
disagree about the schema; that the declaration says `user` and the `FROM` clause
also says `user` is a convention this call keeps, not something the check
enforces. E-211 records that.

**A caller who opened no transaction is safe too.** The lock is only worth
anything for as long as a transaction holds it, and outside a transaction block
it is gone with the statement that took it. The call notices — a row lock
assigns a transaction id, and that id is gone by the next statement in
autocommit — and redoes the whole sequence inside a transaction of its own.
Nothing has been written at the point where it notices. A caller who already
holds a transaction is unaffected: the first attempt completes, and the removal
lands in that transaction and commits or rolls back with it.

Either way, exactly one of two concurrent removals of the last two ways in
succeeds and the other is refused with `last_sign_in_method`.

## One-time artefacts

Email verification, password reset, email change and magic link are the same
object: a row in `velve.one_time_token` keyed by `sha256(token)`, carrying a
purpose and an expiry. The plaintext token exists for exactly as long as it
takes to hand it to the caller; nothing in the library stores it, logs it or
puts it in an error message.

### `randomBytes(length)`

`Uint8Array` of `length` bytes from `crypto.getRandomValues`. Every secret the
library generates comes from here and from nowhere else — this is the one module
that reaches for the CSPRNG (S-RAND-1, S-RAND-5).

| Parameter | Type | Meaning |
|---|---|---|
| `length` | `number` | how many bytes to draw |

### `encodeBase64Url(bytes)`

`string`. Canonical base64url, no padding, written here rather than through
`btoa` for the reason `decodeBase64Url` beside it does not use `atob`: section
2.6 lists the runtime assumptions and neither is among them (E-62, E-257). It is
the encoder for every secret the library hands out; the decoder beside it reads
root keys.

| Parameter | Type | Meaning |
|---|---|---|
| `bytes` | `Uint8Array` | the bytes to encode |

### `SecretToken`

A `string` with a brand on it. A plain string — a user id, a session id, any
other database key — is **not** assignable to `SecretToken`, so a key cannot
arrive where a token is expected without `toSecretToken` being written at the
call site. That is the half of S-RAND-6 this type provides.

The other half does not hold yet: `SecretToken` is a subtype of `string`, so a
token still flows into any parameter typed `string`, including `userId`. Closing
that needs the `EntityId` type S-RAND-6 names, which does not exist in the core;
T-RAND-6 asks for two negative cases that do not compile and one of them does.
The brand is nominal in any case: it says where a value came from, not that the
value is valid.

### `createSecretToken()`

The plaintext of a one-time artefact: 32 bytes from `randomBytes`, base64url
encoded, 43 characters, 256 bit — the same width, the same source and the same
encoding as a session token (S-RAND-4). It takes no parameters, because there is
nothing about a secret for a caller to choose.

### `toSecretToken(value)`

Turns a string that arrived from outside into a `SecretToken`. It validates
nothing, deliberately: a rejected shape would be a second answer beside "no
row", and a malformed token would then be distinguishable from a well-formed one
that was never issued (S-REPLAY-3). Its whole job is to make the step from
untrusted string to lookup key a line someone wrote.

| Parameter | Type | Meaning |
|---|---|---|
| `value` | `string` | whatever arrived claiming to be a token |

### `hashSecretToken(token)`

The 32 bytes stored in `one_time_token.token_sha256`: SHA-256 over the token's
UTF-8 bytes. Any string can be hashed, so a malformed token takes the same path
as a well-formed one that was never issued.

| Parameter | Type | Meaning |
|---|---|---|
| `token` | `SecretToken` | the plaintext handed to the caller, or whatever arrived claiming to be one |

### `ONE_TIME_TOKEN_PURPOSES` and `ONE_TIME_TOKEN_LIFETIME_SECONDS`

The four purposes and the deadline each one carries (section 3.7).

| Purpose | Deadline |
|---|---|
| `email_verify` | 24 hours |
| `password_reset` | 1 hour |
| `email_change` | 1 hour |
| `magic_link` | 10 minutes |

A deadline is not configurable and is not a parameter of any function here. The
purpose decides it, so a caller cannot mint a reset token that outlives the hour.

### `createOneTimeTokenRepository(options)`

The two statements that touch `velve.one_time_token`, and the only ones in the
library that do.

| Option | Type | Meaning |
|---|---|---|
| `driver` | `Driver` | the driver, or the one bound to an open transaction |
| `schema` | `string` | the schema the table lives in |

| Method | Does |
|---|---|
| `replaceOneTimeToken({ tokenSha256, purpose, userId, payload })` | locks the owner's row, then deletes the user's earlier tokens of that purpose and inserts the new row in one statement, returning `{ expiresAt }` |
| `consumeOneTimeToken({ tokenSha256, purpose })` | `DELETE … WHERE token_sha256 = $1 AND purpose = $2 AND expires_at > now() RETURNING user_id, payload`; a `StoredOneTimeToken` or `null` |

`replaceOneTimeToken` runs in a transaction and takes `SELECT 1 FROM velve.user
WHERE id = $1 FOR UPDATE` before it writes. The statement declares what it locks,
`/* locks: <schema>.user */`, which is what `pnpm check:lock-order` reads: a
repository builds its table name from the configured schema, so a scan cannot
otherwise tell which table a lock takes (E-147). The replacement is one statement and
therefore atomic, but at `READ COMMITTED` its `DELETE` works from the snapshot
the statement began with and cannot remove a row a concurrent request inserted
after it; without the lock, eight simultaneous requests leave up to eight live
tokens where section 3.7 allows one.

The lock is wider than the invariant it protects. While it is held, every write
of a user-owned row for that account waits — a concurrent session insert for the
same user blocks — and because the transaction carries the mail send, a hanging
provider holds the lock for its whole timeout. Repository rules section 7 requires
`velve.user` to be locked before any other table, and `pnpm check:lock-order`
enforces it.

Calling this inside `driver.transaction` rolls the whole issue back only if the
driver joins the open transaction rather than opening a second. That is required
of every driver under [the driver interface](#the-driver-interface) above, but it
is a requirement on the implementation and not something the types carry:
`Driver` is two method signatures. `createNodePostgresDriver` satisfies it, so
the rollback of section 3.15 A.7 holds for `@velve/auth/pg` — the only driver
that currently ships, since `@velve/auth/postgres-js` and `@velve/auth/neon`
export nothing. A driver written elsewhere has to satisfy it too.

Every refusal it raises is an `OneTimeTokenError` with a `code`, one class and a
code on it rather than one class per failure.

| Code | Raised when |
|---|---|
| `one_time_token_owner_unknown` | the account the token would belong to does not exist — it was deleted between whatever resolved it and this call |
| `one_time_token_purpose_unknown` | the purpose is not one of the four; only reachable from a caller that is not type-checked |
| `one_time_token_not_written` | the insert reported no row, which is a broken invariant rather than a caller error |

The first two are guards standing in front of the driver: without them the
account case surfaces as a foreign-key violation and the purpose case as a
not-null violation on `expires_at`, each carrying the table and the constraint
name out of the library. The purpose guard runs before any statement, so an
unknown purpose reaches no driver; the account guard runs on the lock, which has
already read the row it needs. Messages are fixed per code, so nothing a caller
passed can reach an error string. What the failure was about travels beside the
code in `purpose`, which is one of the four or `null` for the one code that fires
because the purpose was not one of them (E-129, E-265). All three become
`internal_error` over HTTP.

`consumeOneTimeToken` is the only way a one-time token is ever read. There is no
method that finds one, counts them or looks one up: a read before the write is
the gap two of the advisories behind this library walked through (S-RACE-2).

It is also the one row-removing statement in the library with no owner predicate,
and it carries `/* no owner predicate: S-TOKEN-4 */` in its own SQL to say so — a
block comment, because a line comment swallows everything after it as soon as
anything normalises the newlines away (E-266). The
token is the authority there; the row names the account and nothing a caller
sends does (E-142).

Both methods demand the purpose beside the hash. A lookup without one does not
compile, which is what S-TOKEN-1 asks for.

`expiresAt` comes back as an ISO-8601 instant in UTC — a string, not a `Date`.
The deadline is computed by the database from `now()`, so it is the database
clock that decides both when a token expires and whether it has; and the string
form is the one every driver agrees on.

### `createOneTimeTokens(repository)`

The two operations a flow needs, over that repository.

| Method | Parameters | Returns |
|---|---|---|
| `issue` | `{ purpose, userId, payload? }` | `{ token, expiresAt }` — the plaintext `SecretToken` and its deadline |
| `redeem` | `{ token: SecretToken, purpose }` | `{ purpose, userId, payload }`, or `null` |

Requesting a token supersedes the user's earlier tokens of the same purpose, and
holds under concurrent requests as well as sequential ones (S-TOKEN-3).

`issue` returns the plaintext once. The library keeps no copy: the row holds
the hash, and the token appears in no log line and in no error message. Issuing
inside `driver.transaction` is what makes a rollback possible when the mail that
carries the token cannot be sent (section 3.15 A.7) — subject to the driver
joining the open transaction, as described under `replaceOneTimeToken` above.

`redeem` answers `null` for a token that expired, for one already used, for one
minted for a different purpose and for one that never existed. The four are the
same answer on purpose (S-REPLAY-3): they are indistinguishable to the caller
because they are indistinguishable to the statement, which learns only whether a
row came back. Nothing downstream may reintroduce the difference; the visible
code for all four is `invalid_token`, decided in `error-map.ts` and nowhere else.

`userId` in the answer is the account the token was minted for, and it is the
only account the redemption may act on. No session, cookie or input field takes
part in that decision (S-TOKEN-4). A row that names no user is not redeemable and
answers `null` like the rest.

The row the repository removed is also the evidence an `Actor` is minted from.
`consumeOneTimeToken` returns a `RedeemedOneTimeToken` — the branded shape
`actorOfRedeemedOneTimeToken` takes — and that brand is asserted in this
repository and nowhere else, so a redemption that no `DELETE … RETURNING`
produced cannot become an actor (E-234, E-93).

| Field | Type | Meaning |
|---|---|---|
| `purpose` | `OneTimeTokenPurpose` | the purpose the token was minted and redeemed under |
| `userId` | `string` | the account from `one_time_token.user_id` |
| `payload` | `OneTimeTokenPayload` or `null` | whatever `issue` stored, for example the address an `email_change` moves to |

### The types this module exports

| Type | Shape | Where it appears |
|---|---|---|
| `SecretToken` | branded `string` | the plaintext of an artefact, above |
| `OneTimeTokenPurpose` | `"email_verify" \| "password_reset" \| "email_change" \| "magic_link"` | every signature that touches the table |
| `OneTimeTokenPayload` | `Readonly<Record<string, unknown>>` | what `issue` stores and `redeem` returns |
| `OneTimeTokenRequest` | `{ purpose; userId: string; payload?: OneTimeTokenPayload }` | the argument of `issue` |
| `IssuedOneTimeToken` | `{ token: SecretToken; expiresAt: string }` | the result of `issue` |
| `OneTimeTokenRedemption` | `{ purpose; userId: string; payload: OneTimeTokenPayload \| null }` | the result of `redeem` |
| `OneTimeTokens` | `{ issue; redeem }` | the result of `createOneTimeTokens` |
| `OneTimeTokenRepositoryOptions` | `{ driver: Driver; schema: string }` | the argument of `createOneTimeTokenRepository` |
| `OneTimeTokenReplacement` | `{ tokenSha256: Uint8Array; purpose; userId: string; payload: OneTimeTokenPayload \| null }` | the argument of `replaceOneTimeToken` |
| `OneTimeTokenLookup` | `{ tokenSha256: Uint8Array; purpose }` | the argument of `consumeOneTimeToken` |
| `StoredOneTimeToken` | `RedeemedOneTimeToken & { payload: OneTimeTokenPayload \| null }` | the row `consumeOneTimeToken` returns; a row that names no account answers `null`, exactly as no row does (S-TOKEN-4) |
| `OneTimeTokenRepository` | `{ replaceOneTimeToken; consumeOneTimeToken }` | the result of `createOneTimeTokenRepository` |
| `OneTimeTokenErrorCode` | the three codes in the table above | `OneTimeTokenError.code` |
| `OneTimeTokenError` | `Error` with `code` and `purpose: OneTimeTokenPurpose \| null` | every refusal the repository raises |

`payload` is `Readonly`: the object `redeem` hands back is the row's, not a copy
to edit. `userId` is `string` in `OneTimeTokenRedemption` and `string | null` in
`StoredOneTimeToken`, because the column is nullable and a row that names no
account is not redeemable — the service turns that row into `null` rather than
handing a caller a target it does not have.

## Sessions

The library answers one question — who is signed in — and this module is the
only place that answers it. Every answer costs a database query — one, and a
second only on the request that extends the idle deadline; there is no
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
| `"full"` | the address, canonicalised | the header, bounded to 512 characters |
| `"none"` | `null` | `null` |

`observed` carries what the request layer saw: `{ ipAddress, userAgent }`, each
`string | null`. The result has the same shape and is what the session row is
written with.

The `/64` for IPv6 is the prefix length the rate limiter uses as well, so an
address never appears in two different truncations. `"203.0.113.0/24"` is
stored with its prefix, so a reader can tell a truncated value from a full one.
An address a proxy wrote as an IPv4-mapped IPv6 address (`::ffff:203.0.113.42`)
is read as IPv4 in every mode; treating it as IPv6 would put every IPv4 client
into one `/64`.

`"full"` does not store the header's text. The address is parsed and written
back in the form `inet` holds — RFC 5952 for IPv6, and the unmapped IPv4 form
for `::ffff:203.0.113.42`, which is stored as `203.0.113.42`. What `"full"`
keeps is the whole address rather than a prefix, not the spelling it arrived
in; a value that is not an address at all is stored as `null` in every mode.

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

`deleteSessionByTokenHash` is the one statement here without an owner predicate,
and it says so in its own text: `/* no owner predicate: S-OWNER-2, the predicate
is the secret itself */`. Signing out has a token and nothing else, and the only
form that would satisfy S-OWNER-2 literally — resolve the row, then delete it by
owner — is the pre-`SELECT` the same requirement forbids. A marker is admissible
on that ground alone: the predicate must itself be a secret.

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

`resolve` is the library's only authorisation decision, and it always asks the
database: one query, plus the idle write on the at most one request per
`idleWriteInterval` where that write is due. It throws `account_disabled` when the account is disabled — the only
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

Every event that changes the trust level ends the session that preceded it, and
each event calls the method that matches what preceded it. A sign-in calls
`issue`: there is no session yet, and the second factor is completed out of
`velve.pending_authentication`, which is not one either. An event that follows an
existing session — the second factor completed on top of one, a new identity
linked — calls `reissue`. A password change calls
`reissueAfterCredentialChange`, which has no parameter that could keep the other
sessions (S-FIX-6), and a password reset has no surviving session at all and
calls `revokeEverySessionOfUser`. In every case the token the caller held before
the change is gone from the table, and a request carrying it is answered exactly
like a request without a cookie (S-FIX-1, S-FIX-3).

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

`list`, `revoke`, `revokeEveryOther` and `revokeEvery` — the four B.9 puts the
requirement on — take their actor from `actorOfFreshSession`, which checks
freshness before it hands the actor out, so none of the four can be written
without the check. Three other places obtain an actor without it, each for a
stated reason: `resolve` itself, which needs one to write the idle deadline of
the session it has just resolved; `revokeEverySessionOfUser`, which is handed an
actor rather than minting one, because the password reset has no session to
resolve; and `reissueAfterCredentialChange`, deliberately.

`reissueAfterCredentialChange` is that third case. B.9 puts the
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

### The rest of the session module, by name

`sessionMetadataFor`, `createSessionRepository` and `createSessionService` are
the module's front doors, and everything above describes them. These are the
remaining exported names, each of which the prose above uses without naming.

| Name | Signature | What it is |
|---|---|---|
| `canonicalIpAddress` | `(text: string) => string \| null` | the address as `inet` will hold it — RFC 5952 for IPv6, unmapped for `::ffff:`— or `null` if the text is not an address; re-exported from `core/net/ip-address.ts` |
| `truncatedIpAddress` | `(text: string) => string \| null` | the same, cut to the `/24` or `/64` network and written with its prefix; the two prefix lengths are this module's L-10 decision over `ipAddressNetwork` |
| `truncatedUserAgent` | `(userAgent: string) => string \| null` | `"Chrome on macOS"`; `null` when neither a browser nor a system family is recognised |
| `boundedUserAgent` | `(userAgent: string) => string \| null` | the header trimmed and cut to 512 characters, `null` when it is empty |
| `durationInMilliseconds` | `(duration: string) => number \| null` | a `Duration` in milliseconds; `null` for anything the type admits but a deadline cannot use |
| `DEFAULT_SESSION_METADATA_MODE` | `SessionMetadataMode` | `"truncated"` — the value `sessionMetadata` takes when the configuration says nothing (L-10) |
| `DEFAULT_SESSION_CONFIG` | `SessionConfig` | the table of defaults above, as a value; `sessionSettingsOf` reads a partial configuration over it |

The four address and user-agent functions are the whole of what `"truncated"`
and `"full"` mean; `sessionMetadataFor` chooses between them and does nothing
else.

Types the interface carries: `SessionToken` and `IssuedSessionToken` (from
`createSessionToken`), `SessionConfig`, `SessionSettings` and `Duration`
(configuration), `SessionMetadata` and `SessionMetadataMode` (metadata),
`FreshnessWindow` (`{ freshnessWindowMs, now }`), `SessionResolution`,
`IssuedSession` (`{ token, session }`), `ObservedRequest`
(`{ ipAddress, userAgent }`), `SessionServiceOptions` and `SessionService`, and
on the repository `SessionInsert`, `SessionWithOwner`, `RemovedSession` and
`SessionRepository`. The errors are `InvalidSessionConfigError` (startup),
`SessionOwnerMismatchError` and `PreviousSessionMissingError` (re-issue).

## TOTP and recovery codes

Two second factors, one feature. They share the pending-authentication state,
the `token-pepper` HMAC and the rule that a used artefact is removed by the
statement that reads it, so architecture 3.6 introduces them together and this
chapter documents them together.

Everything here is a service. The routes of the table in architecture 3.15 D.3
— `/factor/totp/enroll/start`, `/factor/totp/enroll/finish`,
`/factor/totp/verify`, `/factor/totp/remove`, `/factor/recovery/generate`,
`/factor/recovery/verify` and `/factor/recovery/remaining` — are assembled by
the instance, not declared here.

### `createTotpService(options)`

Returns a `TotpService`. RFC 6238 with SHA-1, six digits, a thirty-second
period and a tolerance of one step in each direction (architecture 3.6).

| Option | Type | Required | Meaning |
|---|---|---|---|
| `driver` | `Driver` | yes | The PostgreSQL driver. Never imported; always passed. |
| `keys` | `KeyProvider` | yes | Supplies the `totp-enc` key. The secret is encrypted under it and the version is stored beside the ciphertext. |
| `pending` | `PendingAuthenticationService` | yes | The intermediate state `verify` is spent on. |
| `issuer` | `string` | yes | The issuer shown in the authenticator app and written into the key URI. |
| `clock` | `Clock` | yes | The only time the module reads. There is no default: architecture 6.19 says the core reads the time through `clock` alone, and a default would be a second source. Tests pass `createTestClock()` from `@velve/auth/testing`. |
| `schema` | `string` | no | Defaults to `velve`. |

#### `totp.enroll.start({ actor, accountName })`

Draws a fresh 160-bit secret, encrypts it under `totp-enc` and writes
`velve.totp_credential` with `confirmed_at = NULL`. Returns
`TotpEnrollment`:

| Field | Type | Meaning |
|---|---|---|
| `secretBase32` | `string` | RFC 4648 base32, the form an authenticator app accepts when the URI cannot be scanned. |
| `otpauthUri` | `string` | `otpauth://totp/<issuer>:<accountName>?secret=…&issuer=…&algorithm=SHA1&digits=6&period=30`. Every parameter is written out even where it equals the format's default, so an app that changed a default cannot silently disagree. |

While `confirmed_at` is `NULL` the factor counts as absent: an abandoned
attempt is data residue, not a locked-out user, and calling `start` again
replaces it with a new secret. A **confirmed** credential makes `start` raise
`factor_already_enrolled`.

`accountName` is what the authenticator app shows beside the issuer. The
library does not choose it; the caller passes the account's e-mail address or
username.

#### `totp.enroll.finish({ actor, code })`

Verifies `code` against the unconfirmed secret, claims the time step it
matched, and sets `confirmed_at`. Raises `factor_not_enrolled` when no
enrolment was started, `factor_already_enrolled` when one is already
confirmed, and `invalid_factor_code` when the code does not match.

The confirming code is written into `velve.totp_used_step` like any accepted
code. RFC 6238 §5.2 asks that an accepted code be refused for the rest of its
step and does not ask why it was accepted; without the claim, the code typed to
finish enrolment would still work as a second factor for up to sixty seconds.

#### `totp.verify({ pendingToken, code })`

The second-factor check. Resolves the pending state, verifies the code against
the confirmed secret, claims the matched time step, and returns the
`PendingResolution` — it does **not** consume the pending row. S-FIX-1 wants
the row removed in the same transaction that inserts the session, and that
transaction belongs to whoever issues the session.

| Raised | When |
|---|---|
| `invalid_pending_authentication` | The token names no live pending state. |
| `invalid_factor_code` | The code does not match, its step is already spent, the account has no confirmed credential, or the stored secret cannot be decrypted. |
| `too_many_factor_attempts` | The failure that exhausted L-8's budget. The pending row is gone with it. |

The causes behind `invalid_factor_code` differ only in the logged reason —
`totp_code_wrong`, `totp_step_replayed`, `totp_not_confirmed`. This route is
reached with a pending state rather than a session, so answering "this account
has no TOTP" there would say which accounts carry a second factor.

#### `totp.remove({ actor, code })`

Removes the credential and, in the same transaction, every row this account has
in `velve.totp_used_step` — a re-enrolment must not inherit the previous
secret's replay ledger. Demands a valid code: whoever can remove the factor
without holding it has no factor. Raises `factor_not_enrolled` or
`invalid_factor_code`.

#### When the secret cannot be decrypted

`decryptWithPurposeKey` raises `KeyError` when the stored `key_version` is no
longer in the ring (`key_version_unknown`, S-KEY-4) or when the ciphertext does
not authenticate under it (`authentication_failed`). `KeyError` is neither a
`VelveError` nor a `ConcealedError`, so letting it out answers 500 — a status
none of the three declaring routes carries, and one only an account whose secret
predates a rotation can produce.

Every path that decrypts therefore answers `invalid_factor_code` with the logged
reason `totp_not_confirmed`: a secret the server cannot read is a credential
nobody can hold.

**This makes the failure uniform; it does not make it diagnosable.** Dropping a
key version that TOTP secrets were written under turns second-factor sign-in
into a refusal with no explanation for the operator. The check that belongs
above this is an assembly-time one — hold every distinct
`totp_credential.key_version` against the ring when the instance is built, and
refuse to start on one that has left it — so the operator is told once, when
they drop the version. That check is the instance's; this module only makes sure
the request path says nothing an attacker can count on.

#### `totp.isEnrolled({ userId })`

True only for a **confirmed** credential. Takes a user id rather than an
`Actor` because the pending-state path has no actor to offer.

### The replay guard

`S-REPLAY-4` in one statement:

```sql
INSERT INTO velve.totp_used_step (user_id, time_step, expires_at)
VALUES ($1, $2, now() + make_interval(secs => $3::double precision))
ON CONFLICT (user_id, time_step) DO NOTHING
RETURNING time_step
```

No row back means the step was already spent. The conflict is swallowed rather
than raised because `Driver` promises nothing about the shape of a driver's
error, and a refusal that depends on reading SQLSTATE 23505 changes with the
driver. The primary key is still the whole check, and it is what serialises
fifty concurrent submissions of one code onto one winner (`S-RACE-3`).

**The step written is the one that matched, not the one the clock is in.** With
a tolerance of ±1 an accepted code can belong to the step before or after the
current one; recording the current step would leave the matched one free for a
second use.

Rows are kept `TOTP_USED_STEP_RETENTION_SECONDS` — the full tolerance window
plus two minutes — and are swept by `auth.maintenance.sweep()` (L-11).

### TOTP constants

| Name | Value | Why |
|---|---|---|
| `TOTP_ALGORITHM` | `"SHA1"` | Architecture 3.6. Every authenticator app implements it. |
| `TOTP_DIGITS` | `6` | Architecture 3.6. The RFC's own vectors use eight; the library generates six. |
| `TOTP_PERIOD_SECONDS` | `30` | Architecture 3.6. |
| `TOTP_TOLERANCE_STEPS` | `1` | One step either side, so ninety seconds are accepted at any moment. |
| `TOTP_SECRET_BYTES` | `20` | 160 bit. RFC 4226 §4 requires 128 and recommends 160. |
| `TOTP_USED_STEP_RETENTION_SECONDS` | `210` | The widest accepted window (90 s) plus two minutes (L-11). |

`timeStepAt(instant)` is the counter for an instant; `acceptedTimeSteps(instant)`
is the three steps a submission at that instant may match;
`totpCodeForStep(secretBytes, step)` is the code for one step; and
`matchingTimeStep({ secretBytes, submittedCode, at })` answers with the matched
step or `null`. It compares against every candidate without leaving early and
in constant time, so the position of a match inside the window is not readable
from the duration. `normaliseTotpCode` strips spaces and hyphens, because an
authenticator app shows the code in two groups and a reader retypes the gap.

### `createRecoveryCodeService(options)`

| Option | Type | Required | Meaning |
|---|---|---|---|
| `driver` | `Driver` | yes | The PostgreSQL driver. |
| `keys` | `KeyProvider` | yes | Supplies the `token-pepper` key the codes are HMAC'd under. |
| `pending` | `PendingAuthenticationService` | yes | The intermediate state `verify` is spent on. |
| `schema` | `string` | no | Defaults to `velve`. |

#### `recovery.generate({ actor })`

Draws ten codes of 160 bit, deletes every code the account already has and
writes the ten new ones — in one transaction, and after taking the row lock on
`velve.user` that CLAUDE.md §7 requires of any transaction that takes one.
Returns `{ codes }`.

**This is the only moment the plaintext codes exist outside the caller's
process.** What is stored is `HMAC-SHA256(token-pepper, canonical code)`, so
there is no operation that shows a code again — a lost set is regenerated, not
recovered.

The set is always replaced whole. A partially renewed set is a set whose age
nobody knows.

#### `recovery.verify({ pendingToken, code })`

Resolves the pending state, finds the row by HMAC and removes it with
`DELETE … RETURNING`. Returns the `PendingResolution`; like TOTP it does not
consume the pending row.

| Raised | When |
|---|---|
| `invalid_pending_authentication` | The token names no live pending state. |
| `invalid_recovery_code` | No such code for this account, or the account has no codes whose pepper version is still in the ring. |
| `too_many_factor_attempts` | The failure that exhausted L-8's budget. |

#### `recovery.remaining({ actor })`

Returns `{ remainingCount }` and nothing else. The count is the only thing the
stored form can answer.

### The shape of a recovery code

Ten codes, 160 bit each, pairwise distinct (`S-RAND-3`). Encoded in Crockford's
base32 — the alphabet without `I`, `L`, `O` and `U` — as thirty-two characters
shown in four groups of eight:

```
K3M7QR8V-2XN4TZ9B-5PWJ0HC6-Y1DFGS7A
```

The reader normalises before it hashes: upper-cases, drops anything that is not
a digit or a letter, and maps `I` and `L` to `1` and `O` to `0`. A code retyped
in lower case, without its groups, or with a `0` read as an `O` still finds its
row.

| Name | Value |
|---|---|
| `RECOVERY_CODE_COUNT` | `10` |
| `RECOVERY_CODE_ENTROPY_BYTES` | `20` |
| `RECOVERY_CODE_GROUP_LENGTH` | `8` |

`createRecoveryCodeSet()` draws a set, `normaliseRecoveryCode(submitted)` is the
canonical form, and `formatRecoveryCode(canonical)` puts the groups back.

### How a recovery code is stored

`velve.recovery_code` is one row per code:

| Column | Type | Meaning |
|---|---|---|
| `user_id` | `uuid` | The owner. Cascades on deletion of the account. |
| `code_hmac` | `bytea` | `HMAC-SHA256(token-pepper, canonical code)`. Part of the primary key, so a lookup is an index hit and a redemption is one row. |
| `key_version` | `integer` | The `token-pepper` version the HMAC was taken under (L-3). Without it a rotation would void every code, which in `identity: "username"` is the only way back into an account. |
| `created_at` | `timestamptz` | When the set was written. |

Because the version decides the HMAC, a redemption first reads which versions
this account's codes span — `SELECT DISTINCT key_version … WHERE user_id = $1` —
computes the HMAC under each version still in the ring, and then deletes. The
read touches no value that decides validity; the whole validity predicate stays
in the `WHERE` of the statement that removes the row (`S-RACE-2`). A code whose
version has left the ring cannot be recomputed and answers exactly as a wrong
code does.

`generate` always writes the whole set under the current version, so in practice
the ring read finds one version and the redemption is one statement.

### `velve.totp_credential` and `velve.totp_used_step`

| Column | Type | Meaning |
|---|---|---|
| `totp_credential.user_id` | `uuid` | Primary key. One TOTP factor per account. |
| `totp_credential.secret_enc` | `bytea` | AES-256-GCM over the raw secret under the `totp-enc` purpose (`S-REST-4`). |
| `totp_credential.key_version` | `integer` | The `totp-enc` version the ciphertext was written under (`S-KEY-3`). |
| `totp_credential.confirmed_at` | `timestamptz` | `NULL` until a code has proved the app holds the secret. While it is `NULL` the factor does not exist. |
| `totp_credential.created_at` | `timestamptz` | Set again when an unconfirmed enrolment is replaced. |
| `totp_used_step.user_id` | `uuid` | With `time_step`, the primary key that is the replay check. |
| `totp_used_step.time_step` | `bigint` | The step that was accepted. |
| `totp_used_step.expires_at` | `timestamptz` | When `sweep()` may remove the row. |

### The five attempts a pending state allows

`verifyUnderPendingAttemptLimit(pending, token, verify)` holds L-8 for both
factors. It resolves the state, runs the verification, and on failure calls
`registerFailedAttempt`. The limit itself is `MAXIMUM_PENDING_ATTEMPTS` in the
pending module and is not restated here.

A correct code spends no attempt. Wrong codes one to four answer
`invalid_factor_code`; the wrong code that exhausts the budget answers
`too_many_factor_attempts` and takes the pending row with it, which is what
makes the 429 in the route table reachable — a request made after the row is
gone answers `invalid_pending_authentication` instead.

### `identity: "username"` requires recovery codes

`assertRecoveryCodesAreConfigured({ identityMode, recoveryCodes })` raises
`RecoveryCodesRequiredError` — code `recovery_codes_required` — when
`identityMode` is `"username"` and `recoveryCodes` is not on. This is
`S-DEFAULT-4`. An account with no e-mail address has no address a reset can be
sent to, so a configuration that offers neither recovery codes nor a mailbox
ships a lockout.

`recoveryCodesAreMandatoryFor(identityMode)` is the same decision as a
predicate, for a caller that wants to ask rather than to catch.

The check belongs at start-up and is called by the instance; this module is the
mechanism it calls.

## WebAuthn

WebAuthn is two things here, not one. A **passkey sign-in** is a complete
authentication path of its own: a discoverable credential, no password anywhere
in it, and a session whose factors are `["webauthn"]`. A **second factor** after
a correct password is the other, and it yields `["password", "webauthn"]`. Both
are in the core, so there is no path that runs past a hook (architecture 3.6).

A hardware security key is the second-factor case. What tells it apart from a
synchronised passkey is the pair of authenticator flags `BE` and `BS`, stored in
their own columns and rewritten on every sign-in. The library stores them and
enforces no policy; the application builds one.

### `createWebAuthnService(options)`

```ts
createWebAuthnService(options: {
  driver: Driver
  schema?: string            // "velve"
  webauthn: WebAuthnConfig
}): WebAuthnService
```

Everything the library does with WebAuthn. **There is no `clock` option, and
passing one is a compile error.** The only moments this module decides by are
the challenge's five minutes and its expiry, and both are computed and compared
by PostgreSQL in the same statement (E-469). An option that were accepted and
ignored would read like a seam that is not there.

`service.settings` exposes the configuration as it was read, after validation.

### `WebAuthnConfig` — the configuration block

```ts
interface WebAuthnConfig {
  relyingPartyId: string
  relyingPartyName: string
  origins: readonly string[]
  userVerification?: "required" | "preferred"   // "required"
}
```

| Option | Meaning |
|---|---|
| `relyingPartyId` | the eTLD+1 the credentials are scoped to, e.g. `example.com`. A bare hostname: no scheme, no port, no path. |
| `relyingPartyName` | what the authenticator shows the user. Any non-empty string. |
| `origins` | every origin a ceremony may come from. An array, because a relying party legitimately has a web origin and a native one. |
| `userVerification` | what **registration** asks the authenticator for. It does not govern sign-in. |

`"discouraged"` is deliberately absent from the type. A second factor without
user verification is not one, and Better Auth's `requireUserVerification: false`
at both of its verification points is why a passkey there bypasses enforced 2FA
(architecture 1 D33). **Both sign-in paths request and enforce
`userVerification: "required"` unconditionally**, whatever this option says
(E-463). The option decides only what the credential was asked for when it was
created, which is recorded as `wasUserVerifiedAtRegistration`.

An `origins` entry that begins with `http://` or `https://` must equal its own
origin — `https://example.com`, never `https://example.com/`, because a trailing
slash never equals what a browser sends and would refuse every ceremony. Any
other spelling is passed through untouched, so `android:apk-key-hash:…` works
(E-452).

`webAuthnSettingsOf(config)` performs that validation and is what the service
calls. It throws `InvalidWebAuthnConfigError`, whose `code` is one of
`relying_party_id_empty`, `relying_party_id_is_not_a_hostname`,
`relying_party_name_empty`, `origins_empty`, `origin_empty` or
`origin_carries_more_than_an_origin`.

### Registering an authenticator

```ts
service.register.start(input: {
  actor: Actor
  userName: string
  userDisplayName?: string
}): Promise<WebAuthnRegistrationChallenge>

service.register.finish(input: {
  actor: Actor
  challengeToken: string
  response: RegistrationResponseJSON
  label: string
}): Promise<{ credential: WebAuthnCredential }>
```

`userName` and `userDisplayName` are what the authenticator shows in its own
list of credentials. They are parameters rather than something read from the
account, because this module does not read identity columns; the caller passes
what the account is called.

`start` returns `{ publicKeyOptions, challengeToken }`. `publicKeyOptions` goes
to `navigator.credentials.create()` unchanged. It names every credential the
account already has under `excludeCredentials`, so the same authenticator cannot
be enrolled twice, and asks for **`residentKey: "required"`** — a fixed value,
not an option (architecture 1 D37). This is the only ceremony that enrols a
credential, so it is the passkey path's registration whatever else it also
serves, and `"preferred"` means in practice "mostly not": a credential that is
not discoverable never appears in passkey sign-in and nothing says so.

The consequence is worth knowing before you deploy: a security key holds a small
fixed number of discoverable credentials, and one that is full **refuses the
ceremony** rather than making a non-discoverable credential. Such a key cannot
be enrolled as a second factor either, because there is one registration route
for both (E-483).

`challengeToken` is opaque to the caller and comes back to `finish`. It is also
the value inside `publicKeyOptions.challenge`: one 32-byte secret is both the
value the authenticator signs and the pointer to its row, so the ceremony and
the lookup cannot drift apart (E-450).

**`label` is required.** A list of three entries called "Security key" is not a
list anyone can remove from, and the AAGUID knows the model, not the device
(architecture 3.15 B.6).

`finish` fails with `webauthn_challenge_invalid` when the challenge is unknown,
spent, expired or was created for the other ceremony, and with
`webauthn_credential_rejected` when the attestation does not verify — including
when the authenticator did not verify the user and the configuration required
it, and when this authenticator is already registered to some account.

### Signing in with a passkey

```ts
service.passkey.start(): Promise<WebAuthnAuthenticationChallenge>

service.passkey.finish(input: {
  challengeToken: string
  response: AuthenticationResponseJSON
}): Promise<VerifiedWebAuthnAssertion>
```

No account is named, in the request or in the options: `allowCredentials` is
absent, so the authenticator offers whatever discoverable credential it holds
for the relying party, and the account is learned from the credential the user
chose. `userVerification` is `"required"`.

### Completing a second factor

```ts
service.authenticate.start(input: {
  pending: PendingResolution
}): Promise<WebAuthnAuthenticationChallenge>

service.authenticate.finish(input: {
  pending: PendingResolution
  challengeToken: string
  response: AuthenticationResponseJSON
}): Promise<VerifiedWebAuthnAssertion>
```

Both take the resolved intermediate state rather than a session, because between
a correct password and a second factor there is no session (architecture 3.6,
S-FIX-4). `start` names the account's own credentials in `allowCredentials` and
fails with `factor_not_enrolled` when there are none.

The challenge is bound to the account it was issued for. A challenge minted for
a passkey sign-in carries no account and cannot be spent as a second factor; one
minted for an account cannot be spent as a passkey sign-in, or by a different
account. Both rejections are `webauthn_challenge_invalid`.

### `VerifiedWebAuthnAssertion`

```ts
interface VerifiedWebAuthnAssertion {
  userId: string
  credential: WebAuthnCredential
  signCountRegressed: boolean
}
```

What both sign-in paths return. **It contains no session and issues none** — the
assembly decides that, because a passkey sign-in begins anonymous and the
intermediate state is not a session to be replaced (E-470).

`signCountRegressed` is L-9: a sign counter that has fallen back is **reported,
not rejected**, and that is a deliberate documented deviation from WebAuthn
Level 3 §7.2. Synchronised passkeys do not keep the counter reliably, and
refusing would lock legitimate users out. What is reported is a counter that was
running and did not rise: equality counts, because a counter in use has to
increase. An authenticator that keeps no counter reports zero every time and is
never reported as regressed.

The value stored afterwards is the one the authenticator reported, not the
higher of the two. Keeping the maximum would report the fall on every subsequent
sign-in until the authenticator caught up, and a field that is always set is a
field nobody reads (E-462).

### Listing, renaming and removing

```ts
service.list(input: { actor: Actor }): Promise<WebAuthnCredential[]>

service.rename(input: {
  actor: Actor
  credentialId: string
  label: string
}): Promise<{ credential: WebAuthnCredential }>

service.remove(input: { actor: Actor; credentialId: string }): Promise<void>
```

`credentialId` is the row's own `uuid`, which is what `WebAuthnCredential.id`
carries. The WebAuthn credential ID itself never leaves the process: it is a
value that recognises a user across relying parties (architecture 3.15 C.2).

Both take the owner from the resolved session and put it in the SQL predicate,
never in a branch (S-OWNER-2). A credential belonging to another account, one
that never existed, and an identifier that is not a `uuid` at all are one answer
in each direction: `rename` answers `invalid_input` to all three, `remove`
answers 204 to all three and changes nothing (S-OWNER-3, S-OWNER-8).

`remove` fails with `last_sign_in_method` when the credential is the account's
last way in. Counted are a password credential, every WebAuthn credential and
every linked identity; a confirmed email address does not count, and recovery
codes do not count (L-13). It runs through the same `removeSignInMethod` that
`identity.unlink` uses, so there is one deletion path and one lock order, not
two (E-460).

### `WebAuthnCredential`

```ts
interface WebAuthnCredential {
  id: string
  label: string
  transports: readonly string[]
  aaguid: string | null
  isBackupEligible: boolean
  isCurrentlyBackedUp: boolean
  wasUserVerifiedAtRegistration: boolean
  createdAt: Date
  lastUsedAt: Date | null
}
```

| Field | What it is |
|---|---|
| `id` | the row's `uuid`; what `rename` and `remove` take |
| `label` | what the user called this device. Empty for a credential that arrived through the import module, which carries no label |
| `transports` | how the browser said the authenticator can be reached — a hint, never a decision |
| `aaguid` | the authenticator model, or `null` when it declined to name one |
| `isBackupEligible` | the `BE` flag: `true` means a synchronised passkey, `false` means device-bound |
| `isCurrentlyBackedUp` | the `BS` flag: whether it is currently synchronised |
| `wasUserVerifiedAtRegistration` | whether the authenticator verified the user when the credential was created |
| `lastUsedAt` | `null` until the credential has completed a sign-in |

#### Building a policy on `BE` and `BS`

These two are the **only** basis an application has for telling a device-bound
authenticator from a synchronised one, and the library enforces nothing on them.
What they mean:

| `isBackupEligible` | `isCurrentlyBackedUp` | What it is |
|---|---|---|
| `false` | `false` | device-bound. A security key, or a platform authenticator that cannot sync. Losing the device loses the credential. |
| `true` | `false` | a passkey that may be synchronised and is not yet — typically created before the user enabled a keychain |
| `true` | `true` | a synchronised passkey. It exists wherever the user's keychain does, and its security is that account's security. |
| `false` | `true` | does not occur; the verifier rejects it |

**They are rewritten on every sign-in**, not only at registration, because the
second value can change: a passkey created before the user turned on their
keychain is `BE = true, BS = false` at registration and `BE = true, BS = true`
afterwards. A policy that read the registration-time value would keep treating it
as unsynchronised.

An application that wants "a second factor must be device-bound" filters on
`isBackupEligible === false`. One that wants "warn when a factor is now synced"
watches `isCurrentlyBackedUp`. Neither is expressible in the configuration, on
purpose: the library does not know what the application's risk model is.

The import module writes both as `false` when a credential is imported from a
system that does not export them (architecture 4.1 e), which marks a
synchronised passkey as device-bound and would mislead exactly such a policy.
That is why the import defaults to importing no passkeys at all.

### The challenge

Every ceremony is a row in `velve.webauthn_challenge`, valid for **five minutes**
and no more, consumed by a single `DELETE … RETURNING` (S-REPLAY-5).

| Column | Type | What it holds |
|---|---|---|
| `challenge_sha256` | `bytea` | `sha256` of the challenge token — exactly 32 bytes, the primary key (S-REST-2) |
| `purpose` | `text` | `register` or `authenticate`; a challenge is accepted only in the ceremony it was created for |
| `user_id` | `uuid` | the account, or `NULL` for a discoverable passkey sign-in |
| `created_at`, `expires_at` | `timestamptz` | written and compared by PostgreSQL, never by a clock in this process |

The token carries 256 bit from `crypto.getRandomValues`, drawn through the same
module and encoded the same way as the session token (S-RAND-4). The challenge
itself is never stored; only its hash is, so a stolen dump cannot be replayed.

Purpose, account and deadline all stand in the `WHERE` of the consuming
statement, so a challenge used twice, used after five minutes, used in the other
ceremony or used by another account produces no row — and all four answer
`webauthn_challenge_invalid` with the same status and the same body bytes.

Expired rows are removed by `auth.maintenance.sweep()` (L-11); they are already
unusable before that.

### `velve.webauthn_credential`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | the identifier the surface uses |
| `user_id` | `uuid` | `ON DELETE CASCADE` |
| `credential_id` | `bytea` | the WebAuthn credential ID, globally unique. Never leaves the process |
| `public_key` | `bytea` | COSE. Never leaves the process |
| `sign_count` | `bigint` | last reported counter. Never leaves the process; it appears only as `signCountRegressed` |
| `transports` | `text[]` | stored and read as JSON rather than through a delimiter, because the values are the browser's words (E-473) |
| `aaguid` | `uuid` | `NULL` when the authenticator reported all zeros |
| `backup_eligible`, `backup_state` | `boolean` | `BE` and `BS`, rewritten on every sign-in |
| `user_verified_at_registration` | `boolean` | |
| `label` | `text` | `NULL` only for imported rows; the surface shows `""` |
| `created_at`, `last_used_at` | `timestamptz` | |

### The credential payload

`registrationResponse()` and `authenticationResponse()` are the validators for
the JSON `navigator.credentials.create()` and `.get()` produce. Two things about
them are deliberate and visible to a caller.

**An unknown field is ignored, not rejected.** The credential JSON is written by
the browser against a living specification, so a field it grows and this library
does not read is dropped rather than answered with `invalid_input`. The route's
own input around it stays strict (E-455).

**The parsed payload carries no prototype**, on the way out as well as on the
way in. A consumer reads a field through the prototype chain, so the prototype
of the value it is handed is the only thing that decides whether an optional
field the browser did not send comes back as something else (E-481).

**An unknown `transports` value is dropped, not rejected.** A transport is a
hint that no part of the ceremony depends on, and a new one ships in a browser
before it ships in `@simplewebauthn/server`. Rejecting would lock that
authenticator out over an advisory field, so the parser accepts any string and
keeps the ones the verifier can type — which is also what is stored (E-453).
`type` gets no such leniency, because that field decides something.

### What is not here

- **No session.** Both sign-in paths return a verified assertion; the assembly
  issues the session (E-470).
- **No attempt counting.** L-8's five attempts are per intermediate state and
  are counted by the flow that owns it, not per factor (E-471).
- **No attestation.** `attestationType` is `"none"` and no attestation statement
  is evaluated. Velve Auth does not decide which authenticator models an
  application trusts.
- **No conditional UI.** `autocomplete="webauthn"` is an attribute in the
  application's markup; the library supplies the options, not the form
  (architecture 1 D35).

## Email flows

Reserved for `email-flows` (wave 4). Architecture 3.7 and 3.15 B.1, B.4 and
B.5: the artefacts that arrive by mail and are redeemed — the confirmation
link, the address change, the password reset and the magic link — each with the
deadline 3.7 fixes for it, and `S-LINK-4`, the rule that a first confirmation
deletes a password set in a different session and revokes every session that
predates it (L-12).

It stands here because everything it uses stands above it. Its artefacts are the
one-time tokens of that chapter and its deadlines are read from there, the
credential `S-LINK-4` deletes is the Passwords chapter's, and the sessions it
revokes are the Sessions chapter's. What holds it below the two factor chapters
is the result type: `signIn.magicLink.redeem` returns a `SignInResult`, whose
`second_factor_required` branch carries `availableFactors` over `"totp"`,
`"webauthn"` and `"recovery"` (3.15 C.1), so a magic link can end in the pending
state offering a factor those chapters define rather than in a session. The reset
family is not all mailed either — `password.redeemResetWithRecoveryCode` consumes
a recovery code, which is documented two chapters above.

`S-LINK-4`'s deletion is **unconditional**, and the last-way-in count of L-13 is
not a guard on it. That count refuses exactly two operations, `webauthn.remove`
and `identity.unlink`, and a confirmed address is excluded from it although a
magic link works with one (3.15 B.7). L-12's attack is a pre-account whose only
credential is the attacker's password, so a flow that declined to delete it for
leaving no way in would fail closed on precisely the account the rule exists for.

`T-LINK-4` pins that as a number rather than leaving it to reading: on the
attacker path it requires `password_credential` at **0 rows**, every session
created before the confirmation revoked, and the original password refused with
`invalid_credentials` — and it runs on every commit. An implementation that adds
the last-way-in check leaves 1 row and turns the case red. The counter-case in
the same row is the one to keep beside it: the same registration with the
confirmation redeemed **in the same session** keeps `password_credential` at 1
row and leaves the session valid. What separates the two is the provenance of the
password, not a count of credentials.

Empty on purpose. Under §5 of `CLAUDE.md` this chapter is `email-flows`'
partition of this file: that feature appends here and nowhere else, and removing
this paragraph is the first thing it does.

### Nothing is documented here yet

`email-flows` replaces this heading with its own sub-tree.

## OAuth and identity linking

Reserved for `oauth` (wave 4). Architecture 3.10 and 3.15 B.1 and B.7: the
authorisation-code flow with PKCE S256 mandatory, `state` held server-side in
`velve.oauth_flow` with the cookie carrying only the pointer, `nonce` under
OIDC, the `iss` check of RFC 9207, the ID-token signature against JWKS, and the
linking rule — `(provider, subject)` is the only key and the address is never
one (`S-LINK-1` … `S-LINK-7`).

It follows Email flows because the linking rule cites it rather than restating
it. `S-LINK-4` belongs to that chapter, and the three conditions `S-LINK-2` puts
on an automatic link read `email_verified_at` on the local row — the state those
flows produce. A reader who has not read them takes the second condition for a
restatement of the first, which is the reading CVE-2026-53516 shipped.

Empty on purpose. Under §5 of `CLAUDE.md` this chapter is `oauth`'s partition of
this file: that feature appends here and nowhere else, and removing this
paragraph is the first thing it does. Its configuration seam is
`src/core/oauth/config.ts`, which is open and is `oauth`'s file — the field on
`BaseConfig` is already declared, so nothing in `core/auth/config.ts` has to be
edited for it.

### Nothing is documented here yet

`oauth` replaces this heading with its own sub-tree.

## The instance

`createVelveAuth` is the assembly point. It reads the configuration, refuses to
start on a configuration that cannot be made safe, builds the modules the other
chapters describe, and returns one object carrying the route table, the server
methods and the maintenance sweep. Two chapters stand below this one rather than
above it, and both for the same reason: a plugin contributes to the route table
and is refused at start, and the client is derived from the finished table, so
each is read against what this chapter returns.

```ts
import { createVelveAuth, rootKeyProvider } from "@velve/auth";
import { createNodePostgresDriver } from "@velve/auth/pg";
import { toWebHandler } from "@velve/auth/http";

const auth = createVelveAuth({
  database: createNodePostgresDriver(pool),
  identity: { mode: "email" },
  keys: rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: process.env.VELVE_ROOT_KEY! } }),
  origins: ["https://app.example.com"],
  email: { send: async (message) => { /* … */ } },
});

await auth.migrate();
export default toWebHandler(auth);
```

`createVelveAuth` is synchronous. Everything that needs the database — the
migrations and the key-ring report — is in `migrate`, which is the one
asynchronous start step and is meant to be awaited before the first request.

### `createVelveAuth(config)`

```ts
createVelveAuth<M extends IdentityMode>(config: VelveAuthConfig<M>): VelveAuth<M>
```

`M` is inferred from `config.identity.mode`, and everything downstream hangs off
it: in `"email"` the instance has no `username` namespace at all, so reading
`auth.username` is a compile error that names the mode rather than a runtime
`undefined`.

`VelveAuthConfig<M>` is `BaseConfig<M> & RecoveryCodesRequirement<M>`. The second
half is one line and carries a whole requirement: in the mode `"username"` there
is no address to send a reset to, so `recoveryCodes` is **required**, and leaving
it out is a compile error before it is a start error (S-DEFAULT-4).

Both of those sentences depend on one detail that is easy to undo. `M` has
exactly one inference site — `identity`, whose type is `IdentityConfigurationInput
& { readonly mode: M }`, and the `{ mode: M }` half is what TypeScript infers
from. Written as a single conditional type, which reads more naturally, the whole
position becomes non-inferrable: `M` falls back to the union, the conditional
distributes, and both promises above quietly stop holding while still compiling.
It shipped that way once. If you change the shape of `identity`, check that
`createVelveAuth` on a `"username"` mode without `recoveryCodes` still fails to
compile (E-349).

| Field | Type | Default | Meaning |
|---|---|---|---|
| `database` | `Driver` | — | the driver from `@velve/auth/pg`, `/postgres-js` or `/neon`; the only way a connection enters |
| `identity` | `IdentityConfig<M>` | — | which sign-in names exist; decides the CHECK constraint and the instance type |
| `keys` | `KeyProvider` | — | the root key and the ring; all six purpose keys are derived from it |
| `origins` | `readonly string[]` | — | the allowed origins; an empty list is a start error, not a blanket permission |
| `password` | `PasswordConfig` | Passwords chapter | Argon2id parameters, legacy schemes, length bounds, `validate` |
| `session` | `Partial<SessionConfig>` | Sessions chapter | deadlines, cookie name, `SameSite`, freshness window |
| `sessionMetadata` | `"truncated" \| "full" \| "none"` | `"truncated"` | how much of the address and the user agent is stored (L-10) |
| `trustedProxies` | `readonly string[]` | `[]` | CIDR ranges whose `X-Forwarded-For` counts; it reaches the handler through `auth.http`, so `toWebHandler` needs no second copy |
| `rateLimit` | `Partial<RateLimitConfig>` | 10 @ 0.1/s per address, 5 @ 0.01/s per account | bucket sizes and the alert callback |
| `email` | `EmailConfig` | — | the send callback; required in `"email"` and `"username_email"` |
| `webauthn` | `WebAuthnConfig` | none | the relying party; its absence removes the WebAuthn routes |
| `totp` | `Partial<TotpConfig>` | tolerance 1 step | issuer name and tolerance window |
| `recoveryCodes` | `RecoveryCodesConfig` | none; **required** in `"username"` | how many codes and in what grouping |
| `schema` | `string` | `"velve"` | the PostgreSQL schema name |
| `clock` | `Clock` | the system clock | the time source; `@velve/auth/testing` supplies a settable one |
| `log` | `(level, message, fields?) => void` | a sink that drops everything | where the true reason of a refusal is written |

There is no option that disables the origin check, the rate limiter, PKCE or the
state check, and none that keeps the other sessions alive across a password
change (S-DEFAULT-2, S-DEFAULT-3). Those names are absent from the type, and a
test reads the list of them from a constant and searches the assembly for each.

**`log` has no default sink.** The core may not write to `console`, so a library
that ships one would have to break its own rule; the default therefore drops
everything, and an installation that wants to see the true reason behind a
refusal (S-ENUM-6) has to pass a sink. This is the one place in the reference
where a default is *not* the safe choice made for you, and it is called out here
because nothing else would tell you.

### What refuses to start

`VelveStartupError` carries a `code`:

| `code` | Raised when |
|---|---|
| `keys_missing` | `keys` is absent or is not a `KeyProvider` (S-KEY-6) |
| `keys_unusable` | the provider answers for no purpose, so nothing protected could be written |
| `origins_empty` | `origins` is empty |
| `email_callback_missing` | the mode has addresses and `email.send` is absent |
| `recovery_codes_required` | the mode is `"username"` and `recoveryCodes` is absent (S-DEFAULT-4) |

Two more refusals come from the modules and keep their own error types: a root
key shorter than 32 bytes raises `KeyError` while `rootKeyProvider` is being
built, and Argon2id parameters below the floor raise
`PasswordConfigurationError` inside `createVelveAuth` (S-DEFAULT-6). Five start
attempts, four refusals, one instance — that is the shape T-KEY-6 asks for.

### `SECURITY_OPTIONS`

```ts
SECURITY_OPTIONS: readonly { option: OptionKey; safeDefault: string; weakenedBy: string }[]
```

Every key of the configuration type appears here with the value the library uses
when the key is absent and with the sentence that says what weakening it looks
like. It is not documentation about the defaults; it *is* the list a test reads,
and a key added to the configuration without a row here fails that test rather
than surfacing in an advisory (S-DEFAULT-1, T-DEFAULT-1).

At start the assembly writes one `warn` line per weakened option, naming the
option and the value chosen — never two lines for the same option, so the lines
can be counted. An option left at its default produces nothing.

A default configuration writes no line at all. The counters live in
`velve.rate_bucket`, through `createRateLimiter` from `core/limit`; the assembly
translates `globalPerRoute.alertThresholdPerMinute` into the bucket rule that
module takes, which is the same statement in its vocabulary (E-356).

### `TRUST_LEVEL_EVENTS`

```ts
TRUST_LEVEL_EVENTS: readonly ["sign_in_password", "sign_in_passkey", "second_factor_totp",
  "second_factor_webauthn", "second_factor_recovery_code", "password_change",
  "password_reset", "identity_linked"]
TRUST_LEVEL_EVENT_REVOKES_OTHER_SESSIONS: Readonly<Record<TrustLevelEvent, boolean>>
```

The eight events after which the previous session row is gone and a new token
has been issued (S-FIX-1). The second constant answers the question that
separates the two re-issue methods: `password_change` and `password_reset` take
every other session with them, the other six do not. Both were single call sites
waiting to be got wrong; a table-driven test reads the length of the first
constant and fails if the number of cases does not match it.

### The instance

```ts
interface AuthInternals {
  readonly routes: readonly AnyRoute[];
  readonly identityMode: IdentityMode;
  readonly errorCodes: readonly VelveErrorCode[];
  readonly maintenance: { sweep(): Promise<SweepReport> };
  migrate(): Promise<MigrationReport>;
  close(): Promise<void>;
  readonly http: HttpEnvironment;
}
```

`routes` is the data structure `toWebHandler` reads and the client will be built
from; it is present at runtime because a client that has to guess is a client
that guesses wrong. `http` is what `toWebHandler(auth)` takes.

`migrate()` applies the core migrations for the configured mode, then asks the
key provider for every purpose, then holds the `key_version` values already
stored in `password_credential` against the ring. A version that has left the
ring locks out everyone whose row was written under it; the report is addressed
to the operator and is made here, once, rather than on every sign-in, where it
would also split accounts into those written before a rotation and those written
after.

`close()` resolves without doing anything. The connection came from the
application and goes back to it; the library never opened one.

`maintenance.sweep()` deletes expired rows from the seven tables that carry a
`*_sweep_idx` — `session`, `one_time_token`, `pending_authentication`,
`totp_used_step`, `webauthn_challenge`, `oauth_flow` and `rate_bucket` — and
reports how many rows went from each (L-11). It has no HTTP route, on purpose.

### The namespaces

| Namespace | Methods |
|---|---|
| `auth.signOut` | one method; deletes exactly one session row, and an unknown token is not an error |
| `auth.session` | `resolve`, `list`, `revoke`, `revokeAllOther`, `revokeAll`, `refresh` |
| `auth.pending` | `resolve`, `cancel` |
| `auth.user` | `findById`, `findByEmail`, `disable`, `enable`, `delete` |
| `auth.username` | `isAvailable` — present only in `"username"` and `"username_email"` |

Every method reached through a route takes the five call fields beside its own
input: `origin` (required, `string | null`), `sessionToken`, `pendingToken`,
`ipAddress` and `userAgent`. `origin` is required and not optional because a
security field that may be omitted is omitted; the origin check runs on the
direct server call exactly as it runs on the HTTP path (S-CSRF-1).

`auth.user.*` has no routes and never will. The library has no permission model
and cannot decide who may call `disable`; taking that over HTTP unchecked would
be the opposite of a safeguard. `disable` takes a `reason`, which is written to
the log and never stored — an audit log is out of scope — and it leaves the
session rows standing, so each of them ends at its next resolution with
`account_disabled`.

`auth.pending.resolve` names only the factors still open and never any user
data, and it mints no actor: the intermediate state is structurally unable to
become a session.

### The intermediate state between password and second factor

`velve.pending_authentication` holds it, `__Host-velve_pending` carries its
token, and it lives five minutes. Exactly four routes accept it —
`POST /factor/totp/verify`, `POST /factor/webauthn/authenticate/start`,
`POST /factor/webauthn/authenticate/finish` and `POST /factor/recovery/verify` —
and those four names are one constant, `PENDING_CALLER_ROUTES`, so the count a
test reads and the list a route is named from cannot drift apart (S-CACHE-4).
Every other route ignores the cookie completely, and answers a request carrying
only it byte for byte as it answers a request carrying no cookie at all.

```ts
createPendingAuthenticationService({ driver, schema? }): PendingAuthenticationService
```

| Method | Meaning |
|---|---|
| `begin({ userId, factorsCompleted, availableFactors })` | writes the row and draws the token |
| `resolve(token)` | the state, or `null` — for an unknown token, an expired row, and a disabled account alike |
| `consume(token)` | `DELETE … RETURNING`; the removal is the check, so two requests carrying the same token cannot both pass |
| `registerFailedAttempt(token)` | `{ outcome: "attempts_remain", attemptsRemaining }` or `{ outcome: "exhausted" }` |
| `cancel({ token })` | the abort button; without it a half-finished attempt stays valid for five minutes |

```ts
createSecondFactorCompletion({ driver, schema?, session?, sessionMetadata? })
  .complete({ pendingToken, factor, observed }): Promise<IssuedSession>
```

The operation that finishes a second factor: it consumes the pending row and
inserts the session **in one transaction**, so a failure between the two leaves
neither effect. Without it the two halves live in different features — the
pending row in this module, the session in `core/session` — and each can only
reach one of them, which is how a spent intermediate state ends up with no
session behind it. The resulting session carries the factors the pending row had
completed plus the one just proved (S-FIX-1, S-RACE-5).

Five attempts, then the row is deleted and the attempt starts again at the
password (L-8). The count and the deletion are one transaction, so a fifth
failure cannot leave the row behind. A token the service cannot find is reported
as exhausted rather than as a fresh budget.

`resolve` reads the row, the account's `disabled_at` and the factors the account
has actually enrolled in one statement, so no second round trip decides what the
caller may try. An unconfirmed TOTP enrolment counts as no factor: an abandoned
setup is a leftover row, not a locked-out user.

A disabled account answers as an unknown state rather than with the code L-4
reserves for a disabled account. That code belongs to the resolution of a
session that already exists; this is a sign-in still in progress.

### `@velve/auth/testing`

```ts
createTestClock(start?: Date): TestClock   // { now(), set(instant), advanceBy(ms) }
```

The `Clock` a test hands to `clock`. It answers a copy of its instant, so a
caller cannot move it by mutating an answer, and it starts at a fixed instant
when it is given none, so a test that forgets to set one is still deterministic.

Two barriers stand around this subpath and are checked with a count: the core
imports it zero times, and every name it exports appears in `dist/testing.mjs`
and in no other shipped artefact.

The deterministic-randomness setter architecture 6.19 also asks for is **not
here**, and the reason is a check rather than an oversight: the library draws
every secret in `core/token/random.ts`, and a test asserts that the name
`crypto.getRandomValues` appears in that file and nowhere else in anything the
package ships. Every way of redirecting the generator from this subpath names it
here and fails that scan. The switch belongs in `core/token/random.ts` as a
module-level settable source; until it is built there, a test that needs a
reproducible seed brings its own generator.

### What is not assembled yet

The instance is real and the routes it declares work end to end, but it is not
the full table of 3.15 D.3. Absent, because the modules behind them belong to
other features and this one may not write their files:

- `signUp`, `signIn` and the password flows — the password module exists, the
  flows over it do not.
- `factor.totp`, `factor.webauthn`, `factor.recovery` and `signIn.passkey`.
- everything OAuth, and the plugin interface.

The seams these fill are in place. The assembly composes its table from four
modules — its own, `core/oauth/routes.ts`, `core/flows/routes.ts` and
`core/plugin/routes.ts` — and the last three return nothing today, so a feature
adds a row by editing its own file.

The configuration seam is open the same way. `config.oauth` is an `OAuthConfig`
from `core/oauth/config.ts` and `config.plugins` a list of `VelvePlugin` from
`core/plugin/config.ts`; both types are declared and exported, both fields are
optional, and neither is read by the assembly yet — `pluginRoutes` is where
`plugins` will be consumed. The types are documented by the chapters that own
them, which are empty until wave 4.

`GET /pending` and `POST /pending/cancel` are no longer among the missing.
`pendingCookie: "readable"` is what they needed and did not have; both are
declared, both read `__Host-velve_pending` and neither is authorised by it. The
two methods of `auth.pending` still exist beside them and take the token
directly, for a caller that is not a browser.

## Plugins

Reserved for `plugin` (wave 4). Architecture 3.11 and 3.15 G: the registry, the
topological sort over `dependsOn`, the frozen context, the seven enumerated hook
points and the veto a hook holds, and the four things a plugin may contribute —
routes under `/x/<plugin-id>/…`, tables prefixed `<plugin-id>_`, error codes and
rate-limit rules. Also the six things it may not, which 3.11 states as
prohibitions rather than as omissions.

It stands after The instance because each of those four is contributed **to**
something the assembly owns, and the refusal that guards them is a start error. A
route name colliding with a core route is not a warning; the moment it is
detected is the moment `createVelveAuth` runs. So a chapter listing what a plugin
may add can only be read after the chapter that says what it is added to and what
happens when the addition is refused. Its migrations are the same versioned
runner, which stands further above still.

Empty on purpose. Under §5 of `CLAUDE.md` this chapter is `plugin`'s partition of
this file: that feature appends here and nowhere else, and removing this
paragraph is the first thing it does. Its configuration seam is
`src/core/plugin/config.ts`, which is open and is `plugin`'s file — the field on
`BaseConfig` is already declared, so nothing in `core/auth/config.ts` has to be
edited for it.

### Nothing is documented here yet

`plugin` replaces this heading with its own sub-tree.

## The client

Reserved for `client` (wave 4). Architecture 3.15 E: `createVelveClient`, the
`ClientSurface` derived from the same route declaration the server surface is,
the result object that makes `ok` checkable instead of throwable, `unwrap` for a
caller who wants the server's symmetry back, and `VelveTransportError` for the
two failures that can carry no code.

It stands last because it is generated from the route table and adds nothing to
it. The table is assembled by The instance and extended by a plugin; the client
iterates it once at construction and builds an ordinary nested object out of the
`name` fields, so every route this chapter describes is declared in a chapter
above it. There is no `Proxy` and no path assembled from property names, which is
why nothing here can exist that is not written down there.

Empty on purpose. Under §5 of `CLAUDE.md` this chapter is `client`'s partition of
this file: that feature appends here and nowhere else, and removing this
paragraph is the first thing it does.

### Nothing is documented here yet

`client` replaces this heading with its own sub-tree.
