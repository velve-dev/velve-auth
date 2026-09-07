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

### `coreMigrations(identityMode)`

Returns the shipped plan for one identity mode: `"email"`, `"username"` or
`"username_email"`.

### `runMigrations(options)`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `driver` | `Driver` | — | where the statements run |
| `migrations` | `readonly Migration[]` | — | the plan; core migrations plus any a plugin contributes |
| `schema` | `string` | `"velve"` | the PostgreSQL schema to migrate |

A `Migration` is `{ version: number; name: string; sql: string }`. The shipped
SQL names the schema `velve`; when `schema` is something else, the runner
rewrites that identifier before executing. The checksum is taken over the SQL as
shipped, so the same migration in two differently named schemas hashes the same.

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

