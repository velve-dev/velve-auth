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

## HTTP

The HTTP layer turns a route declaration into a request handler. It is the only
place that decides what a caller learns, which cookies exist, and which requests
run at all.

### `toWebHandler(auth, options?)`

```ts
import { toWebHandler } from "@velve/auth/http";

export const POST = toWebHandler(auth, { basePath: "/api/auth" });
```

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
| Handler returned `redirectTo(path)` | `302` with `Location: <path>` and no body |
| Handler returned nothing | `204` with no body |
| Method and path match no route | `404` with no body — the 25 error codes have no code for "no such route" |
| Anything threw | The status of the mapped error code, with the error envelope below |

The error envelope is the only body shape a failed request produces:

```json
{ "error": { "code": "rate_limited", "message": "Too many requests.", "retryAfterSeconds": 30 } }
```

`retryAfterSeconds` appears only where the failure carries one. The message
follows from the code alone, so two requests that fail with the same code get
byte-identical answers.

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

A request that carries one of these two cookies twice is rejected with
`invalid_input` instead of one of the two values being picked (S-COOKIE-5).
Duplicates of other cookie names are ignored, because path-scoped application
cookies legitimately arrive twice.

A session token never appears in a response body: the handler moves a
`sessionToken` or `pendingToken` field out of the handler's output and into the
matching cookie (3.5). The directly called server method returns it, because
there is no cookie there.

### Origin checking

Every route except the OAuth callback declares `originCheck: "checked"`. The
check parses both sides and compares `new URL(x).origin` for equality against the
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

Declaring a route with an ambiguous path, or with `freshness: "required"` without
`caller: "session"`, is a start error rather than a request-time surprise.

### `RequestContext`

| Field | Type | Meaning |
|---|---|---|
| `session` | `Session \| null` | Set for `caller: "session"`. |
| `pending` | `PendingAuthentication \| null` | Set for `caller: "pending"`. |
| `sessionToken` | `string \| null` | The raw cookie value, for routes that answer with `null` instead of failing when no session exists. |
| `ipAddress` | `string \| null` | From `options.clientAddress`. |
| `userAgent` | `string \| null` | From the `User-Agent` header. |
| `cookies` | `CookieWriter` | `setSession`, `clearSession`, `setPending`, `clearPending` — a role, never a name, so no unenumerated cookie can be written. |
| `enforceAccountRateLimit(normalisedIdentifier)` | `Promise<void>` | Consumes the per-account bucket. The identifier must already be normalised (L-5). A route that declares `perAccount` and completes without calling this writes a warning naming the route; where the declaration says `perAccount: "none"` the call does nothing. |

### `HttpEnvironment` — what the instance provides

`auth.http` carries everything the handler needs and nothing it does not.

| Field | Type | Meaning |
|---|---|---|
| `routes` | `readonly AnyRoute[]` | The route table, already filtered by identity mode and configuration. |
| `origins` | `readonly string[]` | The allowed origins. An empty list rejects every checked route. |
| `cookieSameSite` | `"lax" \| "strict"` | |
| `sessionCookieMaximumAgeInSeconds` | `number` | |
| `freshnessWindowInSeconds` | `number` | Measured against `session.createdAt`. |
| `callers` | `CallerResolver` | `resolveSession` and `resolvePending`; both throw, and the error map decides what the caller sees. |
| `rateLimiter` | `RateLimiter` | See below. |
| `clock` | `Clock` | |
| `log` | `(level, message, fields?) => void` | Where the true reason of every concealed failure is written. |

### Failures on the direct server call

The server method throws where the client returns a result (3.15 E), and it
throws exactly what a request would have answered: a `VelveError` carrying one
of the 25 codes, mapped and logged by the same code as the HTTP path. An
application that catches it and forwards `error.code` into its own response
publishes nothing the HTTP answer would not have published.

### The rate limiter seam

`RateLimiter` is the one place a counter hooks into the request chain:

```ts
interface RateLimiter {
  consume(request: {
    routeName: string
    rule: { capacity: number; refillPerSecond: number }
    scope: { kind: "ip_address"; ipAddress: string | null }
         | { kind: "account"; accountIdentifier: string }
  }): Promise<{ allowed: boolean; retryAfterSeconds?: number }>
}
```

An implementation is passed in through `auth.http.rateLimiter` and needs no
change to the HTTP layer. The pipeline consumes the address bucket before the
input is parsed and before the caller is resolved; the route consumes the account
bucket through `context.enforceAccountRateLimit` once it has the identifier,
because the identifier does not exist before parsing. A decision with
`allowed: false` becomes `rate_limited` with the given `retryAfterSeconds`.

The seam is a named field, not a middleware chain: a plugin can neither replace
the origin check nor run before it (3.11).

### Redirects

A handler that must send the caller somewhere returns `redirectTo(path)`, and
the response becomes `302` with `Location: <path>` and no body. A value that is
not a path without a scheme and without a host — `//evil.com`, `https://…`,
`javascript:`, anything carrying a control character — fails with
`internal_error` rather than reaching the header (S-REDIR-3). The full
percent-decoding vector corpus of S-REDIR-2 belongs to the route that accepts a
redirect target from a request, not to this layer, which never accepts one.

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
`internal_error` with no detail in the body; the exception itself is logged.
