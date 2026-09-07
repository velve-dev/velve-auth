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
collides with the application's own tables. Sixteen tables, documented as they
are implemented.

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
character is rejected rather than decoded to the correct bytes. Each key of
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
wrong key or a tampered byte fails as an authentication error from the cipher.

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
`ciphertext_malformed`, `envelope_malformed`, `envelope_algorithm_unsupported`.
The message is fixed per code, so no key material can reach an error string.

There is one error class and a code on it, rather than one class per failure.
Callers switch on `error.code`; `instanceof KeyError` separates this module's
refusals from a fault of the runtime underneath it.
