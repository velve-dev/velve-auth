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
