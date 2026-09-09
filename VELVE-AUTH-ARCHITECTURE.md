# Velve Auth — Target architecture

**As of:** 7 September 2026
**Basis:** Better Auth v1.7.3, commit `e025ce665c5e00df6ca8d9f738ac49fa9dcf1b41`, read in full
**Result:** Target architecture and build brief. No code.
**Translation:** of `VELVE-AUTH-ARCHITEKTUR.md`, which is binding. Where the two
differ, the German is right and this file has a bug.

---

## Summary

Velve Auth is a sign-in library for TypeScript and PostgreSQL that runs inside the application's process. The users live in the operator's database, no third party's service is involved. It answers exclusively **who is signed in**.

**The basis.** Better Auth was read in full: 168,194 lines of TypeScript without tests, 56,097 of them under `packages/better-auth/src`, plus the documentation, the plugin system, all database adapters, the migration guides and the published security advisories. Four agents read separately, their findings were checked against one another; ten contradictions were resolved in the source code (W1–W10). Result: **618 features** in thirteen areas, **78 evidenced gaps**, **33 security advisories**.

**The three findings that determine the design.**

*First: the password path is a dead end.* Better Auth stores `salt_hex:hash_hex` — without an algorithm identifier and without a parameter identifier. There is no rehash at sign-in (`grep -rn "rehash\|needsRehash"` across the whole repository: zero hits), no verifier chain, and Argon2id was rejected as the default (Issue #6608, "closed as not planned"). The consequence stands in its own migration guides: whoever comes from Supabase, Clerk or Auth0 is to switch the library globally to `bcrypt(10)` — that is, **for all new users too, permanently** (`docs/.../supabase-migration-guide.mdx:971`, word for word in `auth0-migration-guide.mdx:595`, the same in substance in `clerk-migration-guide.mdx:47`). For Firebase, the only source with a non-trivial hash, there is no guide at all.

*Second: the email is mandatory and is invented if need be.* `user.email` is `NOT NULL UNIQUE`; the documentation admits it (`concepts/oauth.mdx:409`), Issue #9124 is open. The way out is not advice but production code: `createPlaceholderEmail` (`core/src/utils/email.ts:24`) generates addresses of the form `<id>@<ns>.placeholder.invalid` and is called at nine places in eight modules — Roblox, TikTok, WeChat, Reddit, Twitter, SIWE, Anonymous, Entra ID. No plugin can ever send anything to those addresses.

*Third: the security history has a pattern.* Of 33 advisories, **ten** come down to the same cause — an authorisation check on a user-controlled key without an owner binding, mechanically: the missing line `AND user_id = :actor`. Five come down to incomplete URL and origin checking, three to unverified email as proof of identity (an account takeover every time, twice with CVSS 8.3). The highest ratings reach 9.9 (SCIM namespace collision) and 9.6 (SSRF in the SSO plugin); the most severe one in the core sign-in path is 9.1 and arose from a combination of features: the cookie cache stored the session before the second factor had been checked. Many of the most severe ratings hung on a **default value**, not on a bug.

**The decisions that follow from this.**

| | Better Auth | Velve Auth |
|---|---|---|
| Password storage | `salt:hash`, no marker | canonical PHC string, stored encrypted |
| Scheme | one, globally exchangeable | create Argon2id, verify six prefix families |
| Rehash | none | silently after sign-in, by compare-and-swap |
| Identity | email compulsory | three configurations, email mandatory nowhere |
| Session token | plaintext in the database | only `sha256` stored |
| Session lifetime | one sliding window | idle **and** absolute |
| Cookie cache | default `compact`, unencrypted | none, in no variant |
| Reset revokes sessions | option without a default value | always, without a switch |
| Cookie prefix | `__Host-` defined, never set | `__Host-` throughout |
| Linking | email possible as the key | exclusively `(provider, subject)` |
| Plugins | may override the core and other plugins | enumerated points, a collision is a start error |
| Databases | eleven adapters, lowest common denominator | PostgreSQL, hand-written SQL |
| Migration | five guides, three of them with a bcrypt switch | core feature, five sources, dry run mandatory |
| Runtime | scrypt via export condition | pure TypeScript, exchangeable compute engine |

**The scope.** Of 618 features, 111 are adopted, 157 solved differently, **322 omitted** and 28 surpassed. The omissions are not an economy measure: 133 fall to authorisation and the role of identity provider — a product of its own —, 32 to session variants that contradict the revocation promise, 28 to database abstraction, which disappears with the commitment to PostgreSQL. **36 capabilities** have no counterpart in Better Auth.

**The runtime.** Pure TypeScript, no Rust/WASM module of its own, six dependencies without native bindings. Measured on 2 vCPU, so an order of magnitude rather than an absolute value: Argon2id at OWASP parameters costs 263 ms in JavaScript against 76 ms in WASM — but WASM fails in Cloudflare Workers on `Wasm code generation disallowed by embedder` and is untested on Caprock (ESTIMATE), and a Rust module of one's own would be only 1.6 times faster than off-the-shelf WASM, at the price of a second toolchain and an unauditable binary blob. The decisive finding: `@noble/hashes`, `hash-wasm` and a Rust WASI variant produce **byte-identical** Argon2id hashes. The compute engine is thereby exchangeable without touching a single stored hash.

**The safeguarding.** 123 security requirements in eighteen error classes, each with at least one test case and a number fixed in advance as its threshold; 127 test cases, of which 109 block every commit. Fifteen of the 33 Better Auth advisories transfer directly to Velve Auth and are excluded by named requirements; eighteen are not applicable because the affected feature does not exist.

**Honestly named limits.** In the `username` configuration there is no reset by email — the library refuses to start there if no recovery codes are configured. Usernames are by definition enumerable as soon as an availability check is offered; that stands in the data sheet instead of being a silent gap in the code. The encrypted password storage means: key loss is password loss. Imported bcrypt hashes check only the first 72 bytes until the rehash has replaced them. And whether Node starts on Caprock and the chosen PostgreSQL driver works there is the only notable unverified assumption of the whole design.

---

## Contents

1. Feature comparison — each of the 618 Better Auth features with its decision and reasoning
2. Language and runtime — the assessment, the measurements, the recommendation
3. Target architecture — package structure, schema, sessions, verification path, identity, second factor, tokens, keys, rate limiting, third-party providers, plugins, public interface, error handling, decided gaps
4. Migration module — five sources, per source schema, mapping, hash adoption, losses, follow-up work
5. Security requirements — 123 requirements in eighteen error classes, with a coverage table of the 33 advisories
6. Test plan — 127 test cases with thresholds fixed in advance
7. Decision log — E-01 to E-46, the initial stock for the case study

The build brief lies separately as `CLAUDE-CODE-AUFTRAG.md`.

---
## 1. Feature comparison

The basis is the inventory `findings/08-funktionsinventur.md` (618 features, sections A–M,
Better Auth v1.7.3, commit `e025ce6`) and the target architecture in section 3 including the decided gaps (3.16) and the schema changes (3.17).
The structure follows the inventory. Every row carries exactly one of the four classifications
**Adopt**, **Solve differently**, **Omit**, **Surpass**.

Grouping happens exclusively where the brief allows it: the 36 built-in OAuth providers
(C1–C36), the 10 preconfigured generic OAuth helpers (C37–C46) and the framework rows (K).
Every group stands as its own row and names its individual items. Everything else is listed
individually. The plugins are additionally listed plugin by plugin in section G.2.

Source references are relative to `/home/claude/better-auth/` and come from the preliminary reports. A reasoning that begins with "Like Xn" or "Removed with Xn" adopts the reasoning of row Xn and names after it what is added for this row.

---

### A. Core authentication (52)

| Feature | Better Auth | Velve Auth | Reasoning |
|---|---|---|---|
| A1 Registration with password | `POST /sign-up/email`, creates `user` + `account(providerId:"credential")` (`api/routes/sign-up.ts`) | Adopt | `auth.signUp()` creates `velve.user` + `velve.password_credential` in one transaction. The sign-in name comes from the identity configuration, the route's input schema is derived from it. |
| A2 `emailAndPassword.enabled` | Global switch, default `false` (`core/src/types/init-options.ts:777`) | Solve differently | No boolean switch: the password path exists exactly when the option `password` is set. A switched-off path has no route and no server method, instead of having a route that answers 4xx. |
| A3 `disableSignUp` | Forbids new registration over the credential path (`init-options.ts:783`) | Adopt | `signUp: false` removes the registration route from the route declaration. |
| A4 `autoSignIn` | Session directly after registration, default on (`init-options.ts:855`) | Adopt | Same behaviour, without a switch: registration always delivers a session, even with an unconfirmed address (A5). |
| A5 `requireEmailVerification` | Refuses a session as long as the email is unconfirmed (`init-options.ts:791`) | Solve differently | The option does not exist. Sign-in and registration always deliver a session; `User.emailVerifiedAt` tells the application whether the address is confirmed, and the application decides what an unconfirmed session may do. A sign-in block would firstly be an enumeration channel (S-TIM-7) and secondly a dead end: `email.requestVerification` requires a session, and whoever has lost the registration session would never get to a confirmation mail again without signing in (section 3.15, B.5). |
| A6 Password length policy | `minPasswordLength` 8 / `maxPasswordLength` 128 (`context/create-context.ts:372-373`) | Solve differently | Minimum length 8 per L-7, configurable upwards; the upper limit is not a policy but a hard security bound of 4096 bytes, checked **before** every KDF call (section 3.3, step 1). Better Auth does not check at all before the KDF at `/sign-in/email` (inventory N1-9). |
| A7 Password hashing (scrypt) | scrypt N=16384, r=16, p=1, dkLen=64 as the only scheme (`crypto/password.ts:8-23` only re-exports; parameters and format evidenced in `crypto/password.test.ts:68-80` and `@better-auth/utils@0.5.0 dist/password.node.mjs:3-30`) | Surpass | Argon2id (m=19456, t=2, p=1) is the standard; scrypt remains as a verification scheme. There is not one scheme but a switch over six prefix families (section 3.3). |
| A8 Runtime selection of the scrypt implementation | `node:crypto` on Node/Bun/Deno, `@noble/hashes` otherwise (`crypto/password.ts:1-6`) | Solve differently | `@noble/hashes` is the required path, so that the behaviour is identical everywhere. `hash-wasm` is an optional peer dependency as an accelerator with bit-identical output; a change requires no migration (section 2.1). |
| A9 Hash storage format `salt:hex` | 161-character string without algorithm, parameter or version identifier (`crypto/password.test.ts:11`) | Surpass | Canonical PHC string with scheme and parameters, encrypted in the column with AES-256-GCM under the purpose `password-enc` (L-2). A parameter change no longer devalues existing stock but only produces `needsRehash`. |
| A10 Exchangeable hashing | `password.hash` / `.verify` replace the default completely (`create-context.ts:368-376`) | Omit | Nobody takes that over, and that is right: an exchangeable verifier defeats the scheme switch, the rehash policy, the dummy-hash timing behaviour and the semaphore over the KDF calls all at once. A plugin may not replace the password verifier (section 3.11). Foreign stock comes in through `@velve/auth/import` in PHC form. |
| A11 Sign-in with password | `POST /sign-in/email` (`api/routes/sign-in.ts:406-620`) | Adopt | `auth.signIn.password()`; in the configuration `username_email` the same route accepts both sign-in names. |
| A12 Form CSRF on credential routes | Fetch-metadata protection on `/sign-in/email` and `/sign-up/email` (`api/middlewares/origin-check.ts:303-375`) | Solve differently | A single origin/fetch-metadata check before the route declaration, not as a special case for two routes — and it also runs on direct server calls. In Better Auth, `middlewares`/`onRequest` do not see the path `auth.api.*` (`api/to-auth-endpoints.ts:88-116`). |
| A13 Dummy hash for an unknown user | Computes a hash anyway (`sign-in.ts:536-556`) | Adopt | Dummy PHC with the **configured** default parameters, the same code path, the same semaphore (section 3.3, step 2). |
| A14 Synthetic duplicate response at sign-up | Invents a plausible success response, but only with `requireEmailVerification` or `autoSignIn:false` (`sign-up.ts:236-305`) | Solve differently | No special condition and no invented user object: registration always answers byte-for-byte identically, the difference moves entirely into the message that is sent (section 3.13). |
| A15 `customSyntheticUser` | Allows the synthetic user object including plugin fields to be built oneself (`init-options.ts:899`) | Omit | Nobody. The option exists only because the duplicate response contains a user body; Velve Auth emits none at registration, so there is nothing to fake. |
| A16 `onExistingUserSignUp` | Callback on registration to an address already taken (`init-options.ts:868`) | Solve differently | No hook of its own: the case reaches the application over the same `email.send` callback as all other messages, with a message kind of its own and a sign-in link instead of a confirmation link (section 3.13). |
| A17 `EMAIL_NOT_VERIFIED` abort | Blocks the sign-in after a successful password check (`sign-in.ts:569-601`) | Solve differently | No abort and no error code (A5): the sign-in delivers the session, and `User.emailVerifiedAt` carries the state. The abort after the password check was a status-code oracle for the existence of confirmed accounts (S-TIM-7). |
| A18 `sendOnSignIn` | Verification mail on sign-in of an unverified account (`init-options.ts:736`) | Adopt | Unchanged, over the `email.send` callback. |
| A19 Sign-out | `POST /sign-out` deletes session and cookies (`api/routes/sign-out.ts:36-100`) | Adopt | `DELETE` of the session row plus deletion of the `__Host-` cookie. |
| A20 RP-initiated logout at sign-out | Builds the `end_session` URL of a linked OIDC provider and redirects (`sign-out.ts:101-164`) | Omit | The application takes it over: the provider's claims lie in `velve.identity.profile`, the sign-out at the provider is a product decision and not a task of session management. |
| A21 Generate verification token | HS256 JWT over `secret` with `{email, updateTo?}` (`email-verification.ts:17-43`) | Solve differently | One-time artefact in `velve.one_time_token` with `sha256(token)` as the primary key, consumed by `DELETE … RETURNING` (section 3.7). Better Auth's token is stateless, reusable and not bound to a user ID (inventory N3-21). |
| A22 `GET /verify-email` | Checks the JWT, sets `emailVerified`, redirects (`email-verification.ts:225-340`) | Adopt | As `POST /email/redeem-verification` (section 3.15): consumes the artefact atomically, sets `email_verified_at` and answers with `{ user }`. The library builds no URL and does not redirect; the page the link lands on belongs to the application. |
| A23 `POST /send-verification-email` | Also unauthenticated, with a hard 500 ms minimum runtime (`email-verification.ts:80-220`) | Solve differently | The uniformity comes from byte-for-byte identical responses and the token bucket, not from an artificial minimum runtime that under load becomes a signal itself. |
| A24 `sendVerificationEmail` callback | Mandatory callback, no built-in mailer (`init-options.ts:702`) | Adopt | A single `email.send(message)` callback for all message kinds (section 3.12). No built-in dispatch — expressly (section 3.14). |
| A25 `sendOnSignUp` | Verification mail after the registration (`init-options.ts:729`) | Adopt | Unchanged. |
| A26 `autoSignInAfterVerification` | Session on clicking the verification link (`email-verification.ts:507-535`) | Solve differently | `email.redeemVerification` sets `email_verified_at` and delivers `{ user }`, but no session — a confirmation link is not a sign-in route. Exactly this equation made Better Auth's reusable verification JWT into a permanent login (section 1, A25). The user already has the session from registration or sign-in (A5). |
| A27 `emailVerification.expiresIn` | One option, default 3600 s (`init-options.ts:746`) | Solve differently | Lifetimes are fixed per purpose (confirmation 24 h, reset 1 h, change 1 h, magic link 10 min, section 3.7) instead of over a common option that is always too long for the shortest-lived purpose. |
| A28 `beforeEmailVerification` / `afterEmailVerification` | Two hooks around the verification process (`init-options.ts:752,761`) | Omit | The application takes it over: the extension points are enumerated (section 3.11) and contain no verification hooks. The route's return value says the same thing without foreign code standing in the process. |
| A29 Request a password reset | `POST /request-password-reset`, response always `{status:true}` (`api/routes/password.ts:35-150`) | Adopt | As `POST /password/request-reset` with response 204 without a body, artefact with `purpose='password_reset'`, lifetime 1 h; a newly requested token deletes the previous ones of the same user. |
| A30 Reset link entry | `GET /reset-password/:token` redirects with `?token=` (`password.ts:152-227`) | Adopt | The entry by link remains; the landing page is a page of the application, which passes the token on to `POST /password/redeem-reset`. A redirecting endpoint does not exist, because the library builds no URLs (section 3.15, A.7) — and therefore none that it would have to validate. |
| A31 Reset password | `POST /reset-password`, token consumed atomically (`password.ts:229-335`) | Adopt | As `POST /password/redeem-reset`: consumption and password write in one transaction; the response carries a new session token, all other sessions are revoked (A34). |
| A32 `resetPasswordTokenExpiresIn` | Option, default 3600 s (`init-options.ts:826`) | Solve differently | Fixed lifetime of 1 h, see A27. |
| A33 `onPasswordReset` | Callback after a successful reset (`init-options.ts:831`) | Omit | The application takes it over: it calls the route itself, or gets its result. An additional callback brings no state here that the caller does not already have. |
| A34 `revokeSessionsOnPasswordReset` | Revokes all sessions — **default off** (`password.ts:328-330`) | Surpass | Password reset and password change revoke all other sessions. That is not a switch (section 3.5). A reset that leaves the attacker's session standing is not a reset. |
| A35 Change password | `POST /change-password` with `currentPassword`, optional `revokeOtherSessions` (`update-user.ts:147-310`) | Adopt | Same route; the revocation is obligatory (A34), the current session is reissued. |
| A36 Set password without the old one | `POST /set-password`, serverOnly (`update-user.ts:314-345`) | Adopt | As a server method without an HTTP route, declared with `http: false` in the same route declaration (section 3.12). |
| A37 Verify password | `POST /verify-password`, serverOnly (`password.ts:337-360`) | Adopt | Likewise as a server method; runs through the same switch, the same semaphore and the same rate limiting. |
| A38 Initiate email change | `POST /change-email` with a dummy token when the target address exists (`update-user.ts:668-800`) | Adopt | Same route; the enumeration protection is not a special path here but the general rule of byte-for-byte identical responses. |
| A39 Two-stage email change | `sendChangeEmailConfirmation` from the old address (`init-options.ts:970`) | Adopt | Unchanged: confirmation from the old, after that confirmation of the new address, both as one-time artefacts. |
| A40 `updateEmailWithoutVerification` | Changes the email immediately if the old one was unverified (`init-options.ts:983`) | Omit | Nobody. Exactly this state — an unverified account that somebody created in advance — is the cause of GHSA-qq9h-g4jm-xgf3 and CVE-2026-53516. The change always runs over an artefact to the new address. |
| A41 `user.changeEmail.enabled` | Enables the change (`init-options.ts:964`) | Adopt | Option remains; in the configuration `username` the route does not exist. |
| A42 Initiate account deletion | `POST /delete-user` with password, token or directly (`update-user.ts:370-560`) | Adopt | Same route; "directly" only as a server method, never over HTTP without proof. |
| A43 Confirm account deletion | `GET /delete-user/callback` (`update-user.ts:565-660`) | Adopt | One-time artefact with a `purpose` of its own; the deletion cascades over the foreign keys. |
| A44 `sendDeleteAccountVerification` | Callback for the deletion confirmation mail (`init-options.ts:1000`) | Adopt | Over the same `email.send` callback as a message kind of its own. |
| A45 `beforeDelete` / `afterDelete` | Hooks around the account deletion (`init-options.ts:1013,1019`) | Omit | The application takes it over: its own tables hang on `velve.user` by `ON DELETE CASCADE`, or it clears up before the call. The extension points are enumerated and contain no deletion hook. |
| A46 `deleteTokenExpiresIn` | Validity of the deletion token (`init-options.ts:1025`) | Solve differently | Fixed, purpose-bound lifetime, see A27. |
| A47 Change user data | `POST /update-user` for `name`, `image`, `additionalFields` (`update-user.ts:60-145`) | Omit | The application takes it over. Velve Auth holds no profile data (section 3.14); `name` and `image` belong in an application table with a `user_id` foreign key. A generic write route onto the user row is moreover the way over which plugin fields became writable (inventory N5-60). |
| A48 `checkPassword` helper | Central verify helper, hashes even without a credential account (`utils/password.ts:24-44`) | Adopt | The verification path is exactly one function in `core/password/`, and it is the only place where a KDF is called. |
| A49 Leak check (HaveIBeenPwned) | k-anonymity against HIBP, fail-closed, replaces `ctx.password.hash` (`plugins/haveibeenpwned/index.ts:129-150`) | Omit | The application takes it over: it checks the password before it calls `signUp`/`resetPassword`. A plugin cannot, because the core passes no plaintext password to hooks and the verifier is not replaceable (section 3.11) — and a reimplementation that puts a network call into the sign-in path makes the sign-in dependent on a foreign service. |
| A50 CAPTCHA compulsion on auth routes | Turnstile/reCAPTCHA/hCaptcha/CaptchaFox as `onRequest` (`plugins/captcha/`) | Omit | The application takes it over, in front of its own forms. Better Auth's implementation as `onRequest` has no effect at all on direct server calls (`api/to-auth-endpoints.ts:88-116`) — a reimplementation would suggest a protective effect that does not exist on the server-method path. |
| A51 Health endpoint `GET /ok` | Delivers `{ok:true}` (`api/routes/ok.ts`) | Omit | The application takes it over. A health check belongs to the application, not to a library that runs in the same process. |
| A52 Error page `GET /error` | HTML in dev, 302 in prod (`api/routes/error.ts:374-437`) | Omit | Nobody renders HTML. Velve Auth delivers stable error codes (section 3.13); the application displays them. Reflecting a query parameter back as HTML was GHSA-9x4v-xfq5-m8x5. |

**A: Adopt 23 · Solve differently 14 · Omit 12 · Surpass 3**

---

### B. Sessions (46)

| Feature | Better Auth | Velve Auth | Reasoning |
|---|---|---|---|
| B1 Session creation | `createSession` creates a row with token, `expiresAt`, IP, user agent (`db/internal-adapter.ts:483-519`) | Adopt | Same structure, extended by `factors`, two lifetimes and `token_sha256` instead of plaintext. |
| B2 Session token | 32 characters from a 62-character alphabet, **stored in plaintext** (`internal-adapter.ts:513`) | Surpass | 32 bytes from `crypto.getRandomValues` (256 bit), what is stored is exclusively `sha256(token)`. A database leak discloses no sessions (inventory N3-19). |
| B3 Session fixation protection | Passed-in IDs are ignored (`internal-adapter.ts:483-487`) | Adopt | Tightened: reissue is always `INSERT` + `DELETE` in one transaction; an `UPDATE velve.session SET user_id` does not exist and is prevented by a lint rule and a database trigger (section 3.5). |
| B4 IP and user-agent capture | Are stored, but never used for validation (`internal-adapter.ts:501-502`) | Adopt | What is stored is truncated by default (`sessionMetadata: "truncated"`, L-10): IPv4 to `/24`, IPv6 to `/64`, user agent to browser and system family; the full address only on explicit setting, `ip` as `inet` instead of `text`. Here too no validation: a session bound to the address breaks at every mobile network change. |
| B5 `session.expiresIn` | One lifetime, default 7 days (`create-context.ts:313`) | Solve differently | Two lifetimes instead of one: `idle_expires_at` (default 7 days, extendable) and `absolute_expires_at` (default 30 days, never extended). A single, sliding lifetime has no upper bound. |
| B6 `updateAge` (sliding window) | Extends `expiresAt` on access, default every 24 h (`api/routes/session.ts:324-412`) | Solve differently | Only the idle lifetime is extended, written at most once per hour; the absolute lifetime remains untouched. |
| B7 `session.freshAge` | Defines a "fresh" session, default 1 day (`session.ts:598-616`) | Solve differently | `session.freshnessWindow` (default 15 min) measures against `created_at`, not against the last use, and is restored only by a new sign-in (section 3.15, deviation 7). Which route demands freshness stands as `freshness: "required"` in its declaration; changing the password additionally demands the current password. |
| B8 `freshSessionMiddleware` | Enforces freshness for sensitive endpoints (`session.ts:598-616`) | Omit | Nobody as middleware. Freshness is a field of the route declaration (B7), not a layer that one can forget on a route; and routes that change a state irreversibly additionally demand a proof (password or factor code), because a time window does not protect against an attacker who has only just taken over. |
| B9 `sensitiveSessionMiddleware` | Enforces an authoritative session from DB/secondary storage, bypasses the cookie cache (`session.ts:527-572`) | Omit | Nobody, and that is the point: the middleware exists only because there is a cache. Without a cookie cache every resolution is authoritative, and there is no second class of routes that one can forget (cf. GHSA-xg6x-h9c9-2m83). |
| B10 `disableSessionRefresh` | Switches the extension off globally (`session.ts:339-341`) | Omit | Nobody. The switch exists because of the write load; the hard limit "at most one write per hour and session" takes its purpose away. |
| B11 `?disableRefresh=` per request | Suppresses the extension for one call (`cookies/session-store.ts:293-299`) | Omit | Nobody, same reasoning as B10. A query parameter that changes the session behaviour is moreover attacker-controlled. |
| B12 `setShouldSkipSessionRefresh` | Request-state switch for plugins/server code (`api/state/should-session-refresh.ts:11-14`) | Omit | Nobody, same reasoning. A plugin may not intervene in the session resolution anyway (section 3.11). |
| B13 `deferSessionRefresh` | GET delivers `needsRefresh:true`, writing by POST (`session.ts:75-84,350-365`) | Omit | Nobody. The two-stage sequence exists only because GET may not write on some platforms; with an hourly write limit the write is rare enough to do it directly. |
| B14 `rememberMe: false` | 1 day, session cookie without `maxAge`, plus `dont_remember` cookie (`cookies/index.ts:373-394`) | Solve differently | Same effect without a second cookie: the shorter lifetimes stand in the session row, the cookie is set without `Max-Age`. An additional cookie that steers the behaviour is state outside the database. |
| B15 Query the session | `GET /get-session` delivers `{session,user}` or `null` (`session.ts:60-460`) | Adopt | `auth.session.resolve(token)`: **one** query with a join on `velve.user`, filtered by both lifetimes; `disabled_at` is read in the same query and leads, when set, to `account_disabled` instead of to a session (section 3.5, L-4). |
| B16 `?disableCookieCache=` | Forces the database access for one call (`session.ts:110-135`) | Omit | Nobody — there is no cache that one would have to bypass. |
| B17 List sessions | `GET /list-sessions` (`session.ts:620-670`) | Adopt | Delivers `created_at`, `last_used_at`, `ip`, `user_agent`, `factors`; never the token. |
| B18 Revoke a single session | `POST /revoke-session` with ownership check (`session.ts:676-753`) | Adopt | Unchanged, with the owner check in the `WHERE` predicate instead of in JavaScript. |
| B19 Revoke all sessions | `POST /revoke-sessions` (`session.ts:757-810`) | Adopt | Unchanged. |
| B20 Revoke all other sessions | `POST /revoke-other-sessions` (`session.ts:812-871`) | Adopt | Unchanged; additionally the default path after a password change (A34). |
| B21 Update session fields | `POST /update-session` writes `additionalFields` (`api/routes/update-session.ts`) | Omit | The application takes it over, in its own tables. A generic write route onto the session row is the way over which plugin fields became writable from outside — marked as a problem in the Better Auth code itself (`db/schema.ts:43-47`, inventory N5-60). |
| B22 `session.additionalFields` | Own columns on the session table (`core/src/db/get-tables.ts:190-191`) | Omit | The application or a plugin takes it over, in a table of its own with the prefix `<plugin-id>_` in the schema `velve` (section 3.11). Core tables get no foreign columns. |
| B23 Enable cookie cache | `session.cookieCache.enabled` puts the session into a second cookie (`cookies/index.ts:196-246`) | Omit | Nobody, expressly. Authorisation decisions are never answered out of a cache — that is what GHSA-xg6x-h9c9-2m83 hung on (CVSS 9.1, 2FA bypass, because the session lay in the cache before the second-factor check). |
| B24 Cookie cache strategy `compact` | base64url(JSON) + HMAC, **unencrypted**, default (`cookies/index.ts:223-241`) | Omit | Removed with B23. In addition: the default puts the user row readably into the browser. |
| B25 Cookie cache strategy `jwt` | HS256 JWT over `secret` (`cookies/index.ts:214-222`) | Omit | Removed with B23. A signed JWT in the cookie is a session statement that lives on after the revocation in the database — the same class as B27. |
| B26 Cookie cache strategy `jwe` | JWE `dir` + `A256CBC-HS512`, HKDF key (`crypto/jwt.ts:49-110`) | Omit | Removed with B23. Encryption changes nothing about the fact that the decision comes out of the cookie instead of out of the database. |
| B27 `cookieCache.maxAge` | Lifetime of the cache, default 5 min (`cookies/index.ts:126`) | Omit | Removed with B23. This option is the time a revoked token lives on (inventory N3-25). |
| B28 `cookieCache.refreshCache` | Renews the cache on every access (`init-options.ts:1120`) | Omit | Removed with B23; a cache that extends itself on every access makes its lifetime the session lifetime. |
| B29 `cookieCache.version` | Version marker, invalidates all caches (`session.ts:139-154`) | Omit | Removed with B23. A global invalidation switch is the proof that individual revocation does not work. |
| B30 Cookie chunking | Splits cache cookies >4050 bytes onto `name.0…name.99` (`cookies/session-store.ts:19-131`) | Omit | Nobody. The session cookie carries 43 characters; without a cache there is nothing to chunk. |
| B31 Stateless sessions | Without `database` automatically a `jwe` cookie cache with 7 days (`create-context.ts:102-117`) | Omit | Nobody, expressly. PostgreSQL is mandatory (section 3.2); a session that cannot be revoked is irreconcilable with the immediate revocation from section 3.5. |
| B32 Secondary storage for sessions | Redis/KV as session store (`internal-adapter.ts:557-609`) | Omit | Nobody. Two truths about the session state produce exactly the class of errors from GHSA-2vg6-77g8-24mp: four places in the code deleted the user without removing the sessions in the secondary storage — tokens stayed valid for up to seven days. |
| B33 `storeSessionInDatabase` | Writes sessions additionally into the DB (`init-options.ts:1070`) | Omit | Removed with B32: the database is the only place. |
| B34 `preserveSessionInDatabase` | Keeps DB rows when deleting from the secondary storage (`init-options.ts:1080`) | Omit | Removed with B32. The option regulates which of the two truths wins on deletion; without a second truth there is nothing to regulate. |
| B35 Redis implementation of the secondary storage | `SecondaryStorage` with atomic GET+DEL by Lua (`packages/redis-storage/src/redis-storage.ts:36-53`) | Omit | Removed with B32. The atomic GET+DEL by Lua is technically right and at the same time shows how much care a second store costs that `DELETE … RETURNING` in PostgreSQL delivers for free. |
| B36 Multi-session (several accounts per device) | One signed cookie `<name>_multi-<token>` per session (`plugins/multi-session/index.ts`) | Omit | The application or a plugin under `/x/multi-session/…` takes it over. The core knows exactly one session cookie `__Host-velve_session`; a fan of cookies was the attack surface of GHSA-wmjr-v86c-m9jj (sign-out accepted forged cookie values unchecked). |
| B37 `maximumSessions` | Caps the parallel device sessions, default 5 (`multi-session/index.ts:53`) | Omit | Removed with B36. An upper bound across all devices is moreover a self-displacement: the attacker displaces the user just as much as the other way round. |
| B38 List device sessions | `GET /multi-session/list-device-sessions` | Omit | Removed with B36; `list-sessions` (B17) lists a user's sessions. |
| B39 Switch account | `POST /multi-session/set-active` | Omit | Removed with B36. With exactly one session cookie an account switch is a sign-out plus a sign-in; the application can chain the two. |
| B40 Revoke a single device session | `POST /multi-session/revoke` | Omit | Removed with B36; the revocation of a single session is done by B18 over `targetSessionId`. |
| B41 Session impersonation | `POST /admin/impersonate-user` with `session.impersonatedBy` (`plugins/admin/`) | Omit | The application takes it over. Who may impersonate whom is a permission question, and permissions are expressly not the library's task (section 3.14). |
| B42 End impersonation | `POST /admin/stop-impersonating` | Omit | Removed with B41. Without impersonation there is no state to return to; the way back would otherwise be a session reissue without proof. |
| B43 Rebuild the session response | `customSession` replaces `/get-session` (`plugins/custom-session/index.ts`) | Omit | The application takes it over, after the call. The return type stands in the route declaration, and a plugin may not override core routes — in Better Auth exactly that is an ordering trap (`custom-session/index.ts:71`). |
| B44 Session transfer by one-time token | `/one-time-token/generate` + `/verify` (`plugins/one-time-token/index.ts`) | Omit | The application takes it over. Better Auth puts the session token down as the value of the one-time token (`one-time-token/index.ts:106`) and stores it in plaintext by default (`:76`) — whoever intercepts the token gets the session. |
| B45 Session by `Authorization: Bearer` | Plugin translates a bearer token into a cookie header (`plugins/bearer/index.ts`) | Solve differently | `auth.session.resolve(token)` takes the token directly, no matter where the application gets it from; there is no rewriting of headers into cookies. Better Auth's `requireSignature` stands at `false` by default and thereby accepts unsigned tokens (`bearer/index.ts:78-85`). |
| B46 Reactive session in the client | `useSession` atom with focus/online manager and BroadcastChannel (`client/session-atom.ts`) | Omit | The application takes it over. The client is a typed caller without state management; reactivity belongs in the application's data layer, which it has anyway for everything else. |

**B: Adopt 8 · Solve differently 5 · Omit 32 · Surpass 1**

---

### C. Social sign-in / OAuth (96)

#### C.1 Built-in providers (36) and generic OAuth (11) — grouped

| Feature | Better Auth | Velve Auth | Reasoning |
|---|---|---|---|
| C1–C36 The 36 built-in social providers | Apple, Atlassian, Cloudflare, Cognito, Discord, Dropbox, Facebook, Figma, GitHub, GitLab, Google, Hugging Face, Kakao, Kick, LINE, Linear, LinkedIn, Microsoft Entra ID, Naver, Notion, Paybin, PayPal, Polar, Railway, Reddit, Roblox, Salesforce, Slack, Spotify, TikTok, Twitch, Twitter/X, Vercel, VK, WeChat, Zoom (`packages/core/src/social-providers/`, registered `index.ts:40-76`) | Solve differently | At the start 14 providers (Google, GitHub, Apple, Microsoft/Entra, GitLab, Discord, Facebook, LinkedIn, Twitch, Spotify, Slack, Notion, Zoom, Dropbox) plus `genericOAuth` for everything further; the mechanism is a provider descriptor instead of one file per provider (section 3.10). No race for the count — and the five providers that invent placeholder addresses in Better Auth (Reddit, Roblox, TikTok, Twitter/X, WeChat, `core/src/utils/email.ts`) work here with `email IS NULL`. |
| C37–C46 Preconfigured generic OAuth helpers | Auth0, Gumroad, HubSpot, Keycloak, LINE, Microsoft Entra ID, Okta, Patreon, Slack, Yandex (`plugins/generic-oauth/providers/`) | Solve differently | Four of them (Auth0, Keycloak, Okta, Entra ID) are OIDC providers with a discovery document and reachable over `issuer`; the remaining six are OAuth2 providers with fixed endpoints, which the provider descriptor takes in as `authorizationEndpoint`, `tokenEndpoint`, `userInfoEndpoint` (section 3.15, A.8). Bundled presets age silently as soon as the provider moves an endpoint. |
| C47 Arbitrary OAuth2/OIDC provider at runtime | `genericOAuth({config:[…]})` hangs providers into `ctx.socialProviders` (`generic-oauth/index.ts:511-523`) | Adopt | `genericOAuth` is a core component, not a plugin. Providers are declared as configuration and cannot shadow built-in providers — in Better Auth they are put in front and do shadow them, with a mere warning (`:513-518`). |

#### C.2 OAuth mechanics (49)

| Feature | Better Auth | Velve Auth | Reasoning |
|---|---|---|---|
| C48 Start a social sign-in | `POST /sign-in/social` delivers an authorize URL or redirects | Adopt | Same route; the flow state comes into being as a row in `velve.oauth_flow`. |
| C49 OAuth callback | `GET/POST /callback/:id` (`api/routes/callback.ts`) | Adopt | Same route; code redemption, identity resolution and session creation in one transaction. |
| C50 POST callback → GET redirect | Converts `form_post` into GET so that cookies come along (`callback.ts:62-78`) | Adopt | Necessary for Apple; adopted unchanged. |
| C51 PKCE (S256) | Applied "as soon as a `codeVerifier` exists" (`core/src/oauth2/create-authorization-url.ts:88-92`) | Surpass | PKCE S256 is obligatory, not conditional; the verifier lies AES-256-GCM-encrypted in `velve.oauth_flow.pkce_verifier_enc`, not in the cookie. Better Auth's own OIDC provider silently downgraded a missing `code_challenge_method` to `plain` (GHSA-9h47-pqcx-hjr4). |
| C52 State strategy `database` | State as a verification row (10 min) plus a signed cookie (5 min) (`better-auth/src/state.ts:118-153`) | Adopt | That is the only strategy: `state_sha256` as the primary key, the cookie holds only the pointer. |
| C53 State strategy `cookie` | State encrypted in a 600 s cookie (`better-auth/src/state.ts:94-108`) | Omit | Nobody. The cookie branch never compared the stored nonce with the incoming `state` (GHSA-wxw3-q3m9-c3jr). A server-side state cannot have this error. |
| C54 `account.skipStateCookieCheck` | Global switch that deactivates the state cookie binding (`init-options.ts:1302`) | Omit | Nobody. There is no switch that turns a security check off; the binding to the row is the mechanism. |
| C55 Nonce in the redirect flow | Minted server-side, held in the state, checked fail-closed (`oauth2/state.ts:16-20`) | Adopt | Unchanged, as the column `velve.oauth_flow.nonce`, checked with OIDC. |
| C56 ID token sign-in (native/mobile) | `POST /sign-in/social` with `idToken` + `nonce` instead of a redirect (`sign-in.ts:287-361`) | Omit | Nobody. Native applications run over the authorisation code flow with PKCE in the system browser (RFC 8252). A second entry path that takes a foreign token instead of a code doubles the checking logic at the most sensitive place. |
| C57 Central ID token verification | Signature against JWKS, `iss`, `aud`, `nonce`, expiry (`oauth2/verify-id-token.ts:59-117`) | Adopt | Same checks, but only in the callback — there is no second caller (C56). |
| C58 `verifyIdToken` override per provider | Hook in verification logic of one's own (`oauth-provider.ts`) | Omit | Nobody. The signature and claim check is not replaceable; a plugin may not override it (section 3.11). |
| C59 `disableIdTokenSignIn` | Forbids the ID token path per provider | Omit | Removed with C56: the path does not exist, so it needs no switch. |
| C60 RFC 9207 `iss` check | Compares the `iss` parameter with the provider issuer (`callback.ts:176-185`) | Adopt | Unchanged, obligatory (section 3.10). |
| C61 No redirect following on token requests | 3xx responses of the token endpoint are rejected (`oauth2/reject-redirects.ts`) | Adopt | SSRF hardening, adopted unchanged. |
| C62 `accountSubject` | Mandatory resolver for the stable provider identity (`oauth-provider.ts:176-184`) | Surpass | `(provider, subject)` is not only a convention but `CONSTRAINT identity_provider_subject UNIQUE` in the database. Better Auth checks the uniqueness in JavaScript and is thereby susceptible to races (inventory N4-43). |
| C63 `mapProfileToUser` | Maps the provider profile onto user fields (`oauth-provider.ts`) | Omit | The application takes it over. There are no profile fields that could be mapped onto; the raw claims lie unchanged in `velve.identity.profile` (jsonb), the library does not read them. |
| C64 `getUserInfo` override | Replaces the userinfo retrieval completely (`oauth-provider.ts`) | Solve differently | The provider descriptor declares the userinfo endpoint and claim names as data; there is no exchangeable code path in the sign-in process. |
| C65 `refreshAccessToken` override | Refresh logic of one's own per provider (`oauth-provider.ts`) | Omit | The application takes it over. Velve Auth stores foreign tokens encrypted on express request, but does not renew them — the use of foreign APIs is application logic, not authentication. |
| C66 `validateUserInfo` | Global callback that can accept/reject provider profiles (`init-options.ts:949`) | Solve differently | Over the enumerated extension points `beforeUserCreate` and `beforeSignIn`, which may reject (throw errors) but not replace the response (section 3.11). |
| C67 `scope` / `disableDefaultScope` | Set scopes per provider or switch defaults off | Adopt | Unchanged. |
| C68 Request additional scopes later | `signIn.social` / `linkSocial` with extended `scopes` (`account.ts:126`) | Adopt | Unchanged; the granted scopes land in `velve.identity.scopes`. |
| C69 `prompt` | `select_account`, `consent`, `login`, `none` | Adopt | Unchanged. |
| C70 `responseMode` | `query` or `form_post` | Adopt | Unchanged, necessary for Apple. |
| C71 `loginHint` | Passes `login_hint` through (`sign-in.ts`) | Adopt | Unchanged. |
| C72 `additionalParams` | Arbitrary authorisation parameters, reserved ones protected (`create-authorization-url.ts:11-24,108-113`) | Adopt | Unchanged, with the same blocklist for reserved parameters. |
| C73 `additionalData` through the flow | Pass data of one's own through to the callback (`state.ts`) | Solve differently | What is carried along is exclusively `velve.oauth_flow.redirect_path` — a path, never a complete URL and no free payload. Arbitrary data in the flow state is a detour around the origin check. |
| C74 `redirectURI` override | Deviating callback URL per provider | Adopt | Unchanged, as part of the provider descriptor. |
| C75 `authorizationEndpoint` override | Deviating authorize endpoint per provider | Adopt | Unchanged; necessary for self-hosted GitLab instances. |
| C76 `disableSignUp` per provider | Allows only sign-in of existing accounts | Adopt | Unchanged. |
| C77 `disableImplicitSignUp` | Registration only with an explicit `requestSignUp: true` | Adopt | Unchanged. |
| C78 `overrideUserInfoOnSignIn` | Overwrites the profile data at every sign-in | Solve differently | `velve.identity.profile` is overwritten at every sign-in with the current claims, `velve.user` remains untouched. There is no competition between the provider profile and the local profile, because there is no local profile. |
| C79 `requireEmailVerification` per provider | Demands `email_verified` from the provider | Solve differently | No switch per provider: `provider_email_verified` is one of the three non-negotiable conditions of the linking rule (section 3.10). For the sign-in itself the provider's verification status is irrelevant, because the email is not a key. |
| C80 Account linking globally on/off | `account.accountLinking.enabled`, default `true` (`init-options.ts:1188`) | Solve differently | No global switch. Automatic linking happens only when all three conditions hold (provider reports verified, local account verified, provider in `trustedProviders`); otherwise a new account comes into being or an express linking in an existing session is needed. |
| C81 `trustedProviders` | List of providers whose email counts as proof of ownership (`init-options.ts:1240`) | Adopt | Adopted as one of the three conditions — but never as the sole proof. |
| C82 `allowDifferentEmails` | Allows manual linking with a deviating email (`init-options.ts:1264`) | Solve differently | Needs no switch: since the email is never a linking key, a deviating address is the normal case at an express linking. |
| C83 `allowUnlinkingAll` | Allows the removal of the last linked account (`init-options.ts:1270`) | Solve differently | Instead of a switch the core checks whether a sign-in method still remains after the unlinking (password, passkey or a further identity), and otherwise refuses with `last_sign_in_method` (L-13). That is a statement about the state, not a default setting. |
| C84 `updateUserInfoOnLink` | Updates profile data at linking (`init-options.ts:1280`) | Omit | Removed with C63: there is no profile data in `velve.user`. |
| C85 `disableImplicitLinking` | Forbids automatic linking with the same email (`init-options.ts:1199`) | Solve differently | An empty `trustedProviders` list switches implicit linking off completely — it is the default setting, not an additional switch. |
| C86 `requireLocalEmailVerified` | Additionally demands that the local account is verified (`init-options.ts:1218`) | Surpass | Not an option but condition 2 of the linking rule and not switchable off. Better Auth retrofitted it only as a fix for CVE-2026-53516 (CVSS 8.3) — the auto-link gate never read the local `emailVerified`. |
| C87 Link an account manually | `POST /link-social` in the signed-in state (`account.ts:126`) | Adopt | Over `velve.oauth_flow.link_to_user_id`; the target session is thereby fixed server-side and cannot come out of the callback. |
| C88 Unlink an account | `POST /unlink-account` (`account.ts:453`) | Adopt | Unchanged, with the check from C83. |
| C89 List linked accounts | `GET /list-accounts` (`account.ts:45`) | Adopt | Delivers `provider`, `subject`, `provider_email`, `scopes`, timestamps — never tokens. |
| C90 Retrieve provider account info | `POST /account-info` delivers the raw provider profile (`account.ts:954`) | Solve differently | What is read is `velve.identity.profile` out of the database; the library does not call the provider for it. A live retrieval out of the auth path makes the response time dependent on a foreign service. |
| C91 Fetch access token with auto-refresh | `POST /get-access-token` refreshes on demand (`account.ts:756`) | Omit | The application takes it over. If it switches `storeTokens` on, it gets the decrypted tokens; the renewal belongs to its API client, not to the authentication. |
| C92 Refresh a token explicitly | `POST /refresh-token` (`account.ts:808`) | Omit | Removed with C91; the renewal belongs to the application's API client, which is also the only one that knows when it is necessary. |
| C93 `encryptOAuthTokens` | Encrypts tokens at rest, optional (`init-options.ts:1295`) | Surpass | Not optional: the standard is not to store foreign tokens at all (`storeTokens: false`), and if after all, then AES-256-GCM with the purpose-separated key `oauth-token-enc` and `token_key_version` in the row (section 3.8). |
| C94 `storeAccountCookie` | Puts the account including tokens encrypted into a cookie if no DB exists (`init-options.ts:1325`) | Omit | Nobody. There is no operating mode without a database, and foreign tokens belong under no circumstances in a cookie. |
| C95 OAuth proxy for preview deployments | Forwards callbacks over a fixed production URL to preview URLs (`plugins/oauth-proxy/`) | Omit | Nobody, and that is right: the plugin bypasses the origin binding by design. Preview environments register redirect URIs of their own at the provider — that is the intended way. |
| C96 OAuth in a popup window | An `after` hook replaces the redirect with a `postMessage` page (`plugins/oauth-popup/`) | Omit | The application takes it over. Better Auth's implementation pulls the session token out of the `set-cookie` header and hands it over by `postMessage` to the opener (`oauth-popup/index.ts:317-332`) — the token thereby leaves the cookie channel. |

**C: Adopt 23 · Solve differently 56 · Omit 13 · Surpass 4**

---

### D. Second factor and alternative factors (52)

| Feature | Better Auth | Velve Auth | Reasoning |
|---|---|---|---|
| D1 Activate 2FA | `POST /two-factor/enable` generates a secret + backup codes (`plugins/two-factor/index.ts:124-310`) | Adopt | Same capability, but in the core (`core/factor/`) instead of in a plugin — the intermediate state between password and factor is part of the session model and cannot be retrofitted. |
| D2 Deactivate 2FA | `POST /two-factor/disable` with `sensitiveSessionMiddleware` (`two-factor/index.ts:316-425`) | Adopt | Demands a password or an existing factor; the recovery codes are deleted in the same transaction. |
| D3 Retrieve the TOTP URI | `GET /two-factor/get-totp-uri` delivers the decrypted `otpauth://` URI at any time (`totp/index.ts:301-304`) | Solve differently | The URI is emitted exactly once at the setup, before `confirmed_at`. After that the library no longer hands out the secret; whoever loses the authenticator sets up anew. A secret retrievable at any time turns a session takeover into a permanent factor takeover. |
| D4 Check TOTP | `POST /two-factor/verify-totp` (`totp/index.ts:329-360`) | Adopt | Same route, additionally replay protection over `velve.totp_used_step` with the primary key `(user_id, time_step)`. |
| D5 TOTP parameters | `digits` 6/8, `period` free, `issuer` configurable (`totp/index.ts:83-87`) | Solve differently | Fixed RFC 6238 parameters (SHA-1, 6 digits, 30 s); `issuer` and the tolerance (0 or 1 step, default 1; section 3.15, A.8) remain configurable. Deviating periods and digit counts are silently displayed wrongly by widespread authenticator apps. |
| D6 TOTP secret stored encrypted | 32 characters of randomness, symmetrically encrypted (`two-factor/index.ts:247-251`) | Adopt | AES-256-GCM with the purpose-separated key `totp-enc`, `key_version` in the same row (section 3.8). |
| D7 Generate TOTP server-side | `generateTOTP`, serverOnly (`totp/index.ts:101`) | Adopt | In `@velve/auth/testing`, together with clock control — not in the production package. |
| D8 `skipVerificationOnEnable` | Activates 2FA immediately, without a first TOTP confirmation (`two-factor/index.ts:252-275`) | Omit | Nobody. `confirmed_at` stays NULL until a check has succeeded; otherwise a user locks himself out with a wrongly transferred secret, and exactly this case is the most expensive support incident of an auth library. |
| D9 Send an OTP as a second factor | `POST /two-factor/send-otp`, transport free over `sendOTP` (`otp/index.ts:218-224`) | Omit | A plugin can retrofit it under `/x/…`. A code that comes over the email channel is not a second factor against a password reset that runs over the same channel — Velve Auth knows TOTP, WebAuthn and recovery codes (section 3.6). |
| D10 Check an OTP as a second factor | `POST /two-factor/verify-otp`, attempt budget 5 (`otp/index.ts:334-364`) | Omit | Removed with D9; the attempt budget of five per intermediate state (L-8) applies to the core factors anyway. |
| D11 OTP storage strategy | `plain` (default), `encrypted`, `hashed`, custom (`otp/index.ts:73-140`) | Omit | Removed with D9; `plain` as the default would be the wrong choice anyway. |
| D12 Generate backup codes | `POST /two-factor/generate-backup-codes`, 10 codes of 10 characters (`backup-codes/index.ts:65-70`) | Adopt | 10 of them, 160 bit each, displayed in groups; on a change of scheme all are generated anew and the old ones deleted in the same transaction. |
| D13 Redeem a backup code | `POST /two-factor/verify-backup-code`, compare-and-set (`backup-codes/index.ts:384-405`) | Adopt | Consumption by `DELETE … RETURNING` on `(user_id, code_hmac)` — one index hit instead of a run through all codes. |
| D14 Display backup codes | `viewBackupCodes`, serverOnly — only possible because stored encrypted (`backup-codes/index.ts:552-590`) | Omit | Nobody, and that is the point: codes are held as `HMAC-SHA256(pepper, code)` and are not displayable again. Whoever loses them generates new ones. |
| D15 Backup code storage strategy | `encrypted` (default), `plain` or custom (`backup-codes/index.ts:44-55`) | Surpass | Not a strategy but exactly one format: HMAC with a pepper. Better Auth's default is reversible so that D14 works — a feature forces the weaker storage form there. |
| D16 Intermediate state after the password check | The session is deleted, verification record + signed `two_factor` cookie (`two-factor/index.ts:533-563`) | Surpass | An artefact of its own, `velve.pending_authentication`, with `factors_completed` and `attempts`, a short-lived cookie of its own `__Host-velve_pending` (5 min), and exactly **four** routes accept it (TOTP, WebAuthn `start`/`finish`, recovery code); every other one ignores it completely (section 3.6 and 3.15, deviation 5). The intermediate state is thereby structurally not a session and cannot accidentally become one either. |
| D17 `twoFactorRedirect` response | `{twoFactorRedirect:true, twoFactorMethods:[…]}` instead of a session (`two-factor/index.ts:594-597`) | Adopt | Stable error code plus the list of the factors available for this user. |
| D18 Client-side 2FA redirect | A fetch plugin intercepts the response and navigates (`two-factor/client.ts:57-83`) | Omit | The application takes it over. The client does not navigate by itself; a fetch plugin that intercepts responses and triggers page changes is control flow past the application. |
| D19 Challenge lifetime | `twoFactorCookieMaxAge`, default 10 min (`two-factor/constant.ts`) | Solve differently | A fixed 5 minutes on the `pending_authentication` artefact. The lifetime stands in the database row, not in the cookie lifetime — a cookie with a longer runtime cannot revive an expired state that way. |
| D20 Per-challenge attempt budget | A second verification record `2fa-attempts-…` as an atomic counter (`verify-two-factor.ts:145-193`) | Adopt | As the column `attempts` in the same row, incremented atomically, limit five (L-8) — no second artefact that can drift apart. |
| D21 Account lock on 2FA | 10 failed attempts → 15 min lock (`verify-two-factor.ts:216-319`, `constant.ts:10-11`) | Solve differently | No lock: after five failed attempts the intermediate state is deleted and the process begins again at the password (L-8); above that lies the account bucket from section 3.9, whose exceedance is a refusal, not a delay (L-5). A lock is a denial of service against a known user and thereby itself an attack tool. |
| D22 Atomic challenge redemption | `consumeVerificationValue` **before** session creation (`verify-two-factor.ts:73-83`) | Adopt | The same pattern, as the only consumption pattern: `DELETE … RETURNING` before every state change (section 3.7). |
| D23 Trusted device | HMAC(`userId!trustIdentifier`) + server-side record, default 30 days (`verify-two-factor.ts:99-130`) | Omit | Nobody. A device that skips the second factor for 30 days is a second, weaker sign-in method with a revocation surface of its own. Whoever wants to see the factor rarely instead extends the idle lifetime of the session — then exactly one artefact remains that one can revoke. |
| D24 Trust record rotation | The record is deleted at every use and issued anew (`two-factor/index.ts:463-520`) | Omit | Removed with D23. The rotation is the best part of the mechanism — and the proof that a trust record is a second-class session token, with a revocation and lifetime question of its own. |
| D25 `allowPasswordless` | Loosens the password requirement at activation/deactivation for accounts without a credential (`two-factor/index.ts:53`) | Solve differently | No switch: factor changes demand a proof, and which one is available follows from the account — password, WebAuthn or a recovery code. |
| D26 Own table name for 2FA | `twoFactorTable` (`two-factor/index.ts:602-610`) | Omit | Nobody. Everything lies in the schema `velve` of its own (section 3.2), so nothing collides with the application's tables, and naming options become superfluous. |
| D27 Rate limit on `/two-factor/*` | 3 requests / 10 s (`two-factor/index.ts:611-619`) | Adopt | Same order of magnitude, the key is the resolved route name instead of the raw path (GHSA-x732-6j76-qmhm). |
| D28 Register a passkey (options) | `GET /passkey/generate-register-options` (`packages/passkey/src/routes.ts:169-355`) | Adopt | Challenge as `velve.webauthn_challenge` with `purpose='register'`, 5 minutes, consumed by `DELETE … RETURNING`. |
| D29 Register a passkey (verification) | `POST /passkey/verify-registration` with a ceremony tag check (`routes.ts:567-753`) | Adopt | Same check; additionally `backup_eligible`, `backup_state`, `aaguid`, `transports` and `user_verified_at_registration` are stored. |
| D30 Passkey registration without a session | `registration.requireSession:false` + `resolveUser` (`routes.ts:70-116`) | Adopt | Registration by passkey is a sign-in method of its own (section 3.6), not a special case with callback resolution. |
| D31 `registration.afterVerification` | Create the user only after a successful WebAuthn ceremony (`docs/…/passkey.mdx:108-129`) | Solve differently | Not a switch but the only order: the user comes into being only when the ceremony has succeeded. The reverse order leaves dead entries behind that are abusable as unverified advance accounts. |
| D32 Passkey login (options) | `GET /passkey/generate-authenticate-options`, without a session empty `allowCredentials` (`routes.ts:369-524`) | Adopt | Same behaviour; the challenge row then has `user_id IS NULL` (discoverable sign-in). |
| D33 Passkey login (verification) | `POST /passkey/verify-authentication`, `requireUserVerification: false` (`routes.ts:799-957`, N3-33) | Surpass | `userVerification: "required"`; the session carries `factors = {webauthn}`, and a falling `sign_count` is reported to the application. In Better Auth a passkey is therefore not a second factor and additionally circumvents enforced 2FA (N3-32/33). |
| D34 Usernameless / discoverable credentials | Login without a prior identity statement (`routes.ts:486-499`) | Adopt | Unchanged; that is the regular case of the passkey sign-in method. |
| D35 Conditional UI / browser autofill | `autoFill` default `true`, `autocomplete="webauthn"` (`docs/…/passkey.mdx:325-375`) | Omit | The application takes it over: that is an attribute in its markup. The library delivers the options, not the form. |
| D36 WebAuthn extensions | PRF, credProps, largeBlob passable through (`docs/…/passkey.mdx`) | Omit | Nobody. The ceremony is not extensible; what is evaluated is BE/BS and `sign_count`. Whoever needs PRF for key derivation runs a ceremony of their own — a half-passed-through extension is worse than none. |
| D37 `authenticatorSelection` | `residentKey` default `preferred`, `userVerification` default `preferred` (`routes.ts:304-327`) | Solve differently | Fixed defaults instead of options: `residentKey: "required"` and `userVerification: "required"` for the passkey path, `userVerification: "required"` as a second factor too. `preferred` means in practice "mostly not". |
| D38 `rpID` / `rpName` / `origin` | `origin` falls back to the request header (`packages/passkey/src/utils.ts:3-8`) | Solve differently | `rpID` and `origin` are mandatory configuration and are never derived from a request header. An origin derived from the request is the WebAuthn variant of CVE-2025-71401. |
| D39 List passkeys | `GET /passkey/list-user-passkeys` (`routes.ts:996`) | Adopt | Delivers `label`, `aaguid`, `transports`, `backup_eligible`, `backup_state`, `created_at`, `last_used_at`. |
| D40 Delete a passkey | `POST /passkey/delete-passkey` (`routes.ts:1063`) | Adopt | With the owner check in the `WHERE` predicate — exactly that was missing in GHSA-4vcf-q4xf-f48m (IDOR). |
| D41 Rename a passkey | `POST /passkey/update-passkey` (`routes.ts:1139`) | Adopt | Writes `label`, nothing else. |
| D42 Authenticator recognition by AAGUID | Bundled name table (`packages/passkey/src/authenticator-metadata.ts`) | Omit | The application takes it over. The `aaguid` is stored; a bundled name table ages between two releases and is pure display logic. |
| D43 Device-bound vs. synchronised | `deviceType` and `backedUp` are stored (`packages/passkey/src/schema.ts:3-53`) | Surpass | The BE and BS flags are stored separately out of the authenticator data and updated at every sign-in; the application can base a policy on them (e.g. "device-bound counts as a second factor"), the library enforces none (section 3.6). |
| D44 Sign-In with Ethereum (SIWE) | `POST /siwe/verify` checks the complete ERC-4361 message (`plugins/siwe/index.ts:158-190`) | Omit | A plugin takes it over: routes of its own under `/x/siwe/…`, a table of its own `velve.siwe_wallet`. A wallet protocol with a signature library of its own does not belong in the required path of an auth library. |
| D45 SIWE nonce | `GET /siwe/nonce`, consumed atomically before the signature check (`siwe/index.ts:62-156`) | Omit | Removed with D44; the pattern itself (consumption before the check) is adopted as a general rule (section 3.7). |
| D46 Store wallet addresses | Table `walletAddress` with `chainId`, `isPrimary` (`siwe/schema.ts`) | Omit | Removed with D44; the table belongs to the plugin, as `velve.siwe_wallet` with a prefix per section 3.11. |
| D47 Google One Tap | `POST /one-tap/callback` verifies the Google `id_token` (`plugins/one-tap/index.ts:107-118`) | Omit | Nobody. It presupposes the direct ID token entry, which does not exist (C56); the authorisation code flow covers Google completely. |
| D48 Magic link | `POST /sign-in/magic-link` + `GET /magic-link/verify`, TTL 5 min (`plugins/magic-link/index.ts`) | Adopt | In the core instead of as a plugin: one-time artefact with `purpose='magic_link'`, lifetime 10 min, consumption by `DELETE … RETURNING`. |
| D49 Magic link token storage strategy | `plain` (default), `hashed` or custom (`magic-link/index.ts:163-186`) | Surpass | No strategy: one-time artefacts are held without exception as `sha256(token)`, because `token_sha256` is the table's primary key. The Better Auth default stores the sign-in link in plaintext in the database. |
| D50 Anonymous sign-in | `POST /sign-in/anonymous` creates a real user with a placeholder email (`plugins/anonymous/index.ts:104-113`) | Omit | The application takes it over: a guest state without an identity belongs in its own table. Better Auth invents an address for it and creates a user row that afterwards has to be collected in again over an `after` hook on very many foreign paths (`:334-418`). |
| D51 Link an anonymous account | An `after` hook over many sign-in paths calls `onLinkAccount` (`anonymous/index.ts:334-418`) | Omit | Removed with D50. An `after` hook over many foreign sign-in paths is moreover exactly the kind of hook that section 3.11 excludes. |
| D52 Delete an anonymous user | `POST /delete-anonymous-user` | Omit | Removed with D50; a guest state is deleted by the application in its own table. |

**D: Adopt 20 · Solve differently 8 · Omit 19 · Surpass 5**

---

### E. Identity and user model (27)

| Feature | Better Auth | Velve Auth | Reasoning |
|---|---|---|---|
| E1 Core user model | `id`, `name`, `email`, `emailVerified`, `image`, `createdAt`, `updatedAt` (`core/src/db/get-tables.ts:198-246`) | Solve differently | `velve.user` carries `id`, `email`, `email_verified_at`, `username`, `username_key`, `disabled_at`, `imported_from`, `imported_at` and timestamps — no `name`, no `image`. Profile data is expressly not the library's task (section 3.14). Instead of a boolean, the point in time of the verification stands in the row. |
| E2 Email as a mandatory field | `email` is `NOT NULL UNIQUE` (`get-tables.ts:208-216`); docs: "Better Auth currently requires an email address on every user record" (`docs/…/concepts/oauth.mdx:409`, Issue #9124) | Surpass | `email` is nullable; which fields are mandatory is decided by the chosen identity configuration and is materialised as a CHECK constraint in the migration (section 3.4). That is the precondition for getting by without invented addresses at all. |
| E3 Placeholder email generator | `createPlaceholderEmail` → `<id>@<ns>.placeholder.invalid`, called at nine places in eight modules in the production code (defined in `core/src/utils/email.ts:24`) | Omit | Nobody, and that is the point. If a provider reports no email, `user.email` stays NULL (section 3.10). Invented addresses break every email-dependent behaviour — confirmation, reset, change — and are not distinguishable from real ones in the database. |
| E4 Email normalisation | `.toLowerCase()` scattered over more than 30 call sites (`internal-adapter.ts:241,279,1045,1096`) | Surpass | Trimming, NFKC and `lower()` at exactly one place, and the database checks it afterwards by `CONSTRAINT user_email_normalized CHECK (email = lower(email))`. A forgotten call site cannot create a second spelling of the same address. |
| E5 `user.additionalFields` | Own user columns with `input`/`returned`/`transform` (`get-tables.ts:243`) | Omit | The application takes it over, in a table of its own with a `user_id` foreign key. Foreign fields in the user row are `input: true` by default in Better Auth and thereby writable over generic routes — marked as a problem in the code itself (`db/schema.ts:43-47`). |
| E6 `session.additionalFields` | Analogously for the session table (`get-tables.ts:191`) | Omit | Like E5; plugins get tables of their own with a prefix, not columns on core tables (section 3.11). |
| E7 `account.additionalFields` | Analogously for the account table (`get-tables.ts:338`) | Omit | Like E5. For provider data there is `velve.identity.profile` (jsonb), which the library writes and does not read. |
| E8 `verification.additionalFields` | Analogously for the verification table (`get-tables.ts:124`) | Omit | Like E5. `velve.one_time_token.payload` (jsonb) takes in purpose-bound payload without changing the schema. |
| E9 Field mapping (`fields`) | Rename physical column names freely (`init-options.ts:241`) | Omit | Nobody. Everything lies in the schema `velve` of its own (section 3.2); nothing collides there, so there is nothing to rename. Renameable columns make every hand-written SQL impossible. |
| E10 Table mapping (`modelName`) | Rename physical table names freely (`init-options.ts:237`) | Omit | Like E9. `user` too needs no quotation-mark discipline in a schema of its own. |
| E11 `usePlural` | Appends an "s" across the board to all table names (`schema-diff.ts:59`) | Omit | Like E9; an "s" appended across the board is not pluralisation but a rename with side effects in every hand-written SQL. |
| E12 ID strategy: default | 32 characters base62, generated in the application (`core/src/utils/id.ts:3-5`) | Solve differently | `uuid PRIMARY KEY DEFAULT gen_random_uuid()` — the database generates the ID. There is thereby no path on which an ID can be passed in from outside. |
| E13 ID strategy: own function | `advanced.database.generateId` (`get-id-field.ts:66-70`) | Omit | Nobody. One ID strategy, at one place. Four strategies side by side produce in Better Auth the case that the application type says `string` and the column is `integer` (E15). |
| E14 ID strategy: `"uuid"` | `uuid` column with `DEFAULT gen_random_uuid()` (`db/get-migration.ts:923-924`) | Adopt | That is the only strategy in Velve Auth. |
| E15 ID strategy: `"serial"` | `integer GENERATED BY DEFAULT AS IDENTITY`, in the type nevertheless `string` (`get-migration.ts:921-922`) | Omit | Nobody. Consecutive IDs are enumerable, and the type break between column and application type is a source of errors without any counter-value. |
| E16 ID strategy: `false` | The database generates the ID (`get-id-field.ts:62-63`) | Adopt | That is exactly the behaviour of Velve Auth — only not as one of four options but as the behaviour. |
| E17 Adapter `customIdGenerator` | Adapter's own ID generator, used only by Mongo (`db/adapter/index.ts:287`) | Omit | Nobody. The option exists because MongoDB generates `ObjectId` instead of strings; in PostgreSQL the database generates the `uuid` itself (E12), so no driver needs a generator of its own. |
| E18 `forceAllowId` | Allows an ID to be passed in at `create` as an exception (`db/adapter/factory.ts:884-906`) | Solve differently | Only `@velve/auth/import` may bring IDs along, so that an existing stock keeps its foreign keys; in normal operation the path does not exist. The origin stands afterwards in `imported_from`/`imported_at`. |
| E19 Username as an additional identifier | `user.username` (unique) + `user.displayUsername` per plugin (`plugins/username/schema.ts:6-58`) | Surpass | Username is one of the three core identity configurations, not a plugin that hangs a column onto the user table. `username` holds the display form, `username_key` the comparison form, both with a partial unique index of their own and a CHECK pairing rule (section 3.2 and 3.4). |
| E20 Sign-in by username | `POST /sign-in/username` with dummy-hash timing-behaviour protection (`plugins/username/index.ts:353-560`) | Adopt | In the core, over the same route as the password sign-in; dummy PHC and semaphore are the same as with email. |
| E21 Check username availability | `POST /is-username-available`, switchable off (`username/index.ts:569`) | Adopt | It is offered, hard-limited and expressly designated in the documentation as enumerable, instead of being presented as protected (section 3.4). |
| E22 Username normalisation | Field-level `transform.input` (default `toLowerCase`), switchable off (`username/index.ts:143-158`) | Solve differently | NFKC plus `toLowerCase()` in `username_key` at exactly one place in the core, not switchable off, checked afterwards by a CHECK constraint; the display form is preserved. A normalisation that can be switched off is a uniqueness protection that can be switched off. |
| E23 Username validation | `min` 3 / `max` 30, regex `/^[a-zA-Z0-9_.]+$/`, `validationOrder` (`username/index.ts:113-186`) | Solve differently | Configurable character-class allowlist, standard `[a-z0-9_-]`, 3–32 characters. The allowlist is at the same time the homoglyph protection: what is not permitted does not have to be compared either. The dot is deliberately dropped, because in many typefaces it is barely distinguishable from other characters. |
| E24 `immutableUsername` | Forbids changes once set (`username/index.ts:96-99`) | Adopt | Option, unchanged. |
| E25 Telephone number as an identity | `user.phoneNumber` (unique) + `user.phoneNumberVerified` (`plugins/phone-number/`) | Omit | A plugin takes it over: a table of its own, routes of its own under `/x/…`, SMS dispatch as a callback of the application anyway. There are three identity configurations (section 3.4), and a fourth would have the same burden of proof as the other three. |
| E26 Registration by telephone number | `signUpOnVerification` creates the user with a placeholder email (`phone-number/routes.ts:578-600`) | Omit | Removed with E25 — and would be excluded in this form anyway (E3). |
| E27 Remember the last sign-in method | Cookie (not httpOnly) and optionally `user.lastLoginMethod` (`plugins/last-login-method/index.ts:186`) | Omit | The application takes it over. A non-httpOnly cookie out of an auth library is a channel that the library no longer controls; the application can remember that for itself with a cookie of its own. |

**E: Adopt 5 · Solve differently 5 · Omit 14 · Surpass 3**

---

### F. Database (58)

| Feature | Better Auth | Velve Auth | Reasoning |
|---|---|---|---|
| F1 Kysely adapter (PostgreSQL) | `pg.Pool` detection, transactions on (`packages/kysely-adapter/src/dialect.ts:116`) | Solve differently | No Kysely and no query abstraction: three narrow drivers (`@velve/auth/pg`, `/postgres-js`, `/neon`) behind an interface with exactly two methods (`query`, `transaction`), all SQL written by hand for PostgreSQL (section 3.2). |
| F2 Kysely adapter (MySQL) | `mysql2` detection (`dialect.ts:109`) | Omit | Nobody. Exactly one database: PostgreSQL ≥ 14 (section 3.2). Partial indexes, `inet`, `text[]`, `jsonb`, `ON CONFLICT … RETURNING`, CHECK constraints and triggers are load-bearing parts of the design — uniqueness, consumption, rate limiting and fixation protection stand in the database, not in the application code. A second target system would have to either rebuild each of these guarantees or lower them to the lowest common denominator; Better Auth's adapter API shows what then remains (F23, F48, F54, F55). |
| F3 Kysely adapter (better-sqlite3) | Detection over `aggregate` (`dialect.ts:103`) | Omit | Like F2. SQLite knows neither `inet`, `text[]`, `timestamptz` nor `gen_random_uuid()`; lifetime predicates, IP normalisation and ID generation would have to move into the application code. |
| F4 Kysely adapter (Bun SQLite) | Detection over `fileControl` (`bun-sqlite-dialect.ts`) | Omit | Like F2; the same SQLite limit as F3, only reached over the Bun runtime. |
| F5 Kysely adapter (`node:sqlite`) | Detection over `createSession` + `DatabaseSync` (`node-sqlite-dialect.ts`) | Omit | Like F2; the same SQLite limit as F3, reached over Node's built-in module. |
| F6 Kysely adapter (Cloudflare D1) | A dialect of its own **without** transactions (`d1-sqlite-dialect.ts`) | Omit | Like F2, and sharper: without transactions, registration, identity linking and session reissue cannot be carried out atomically. A target that does not fulfil the guarantee is not offered in the first place. |
| F7 Kysely adapter (MS SQL Server) | Over an arbitrary Kysely dialect (`dialect.ts`) | Omit | Like F2. MS SQL Server has no `ON CONFLICT … RETURNING`; the upsert of the rate limiting (section 3.9) would be a `MERGE` there with a concurrency history of its own. |
| F8 Arbitrary Kysely dialect | `createDriver` detection for community dialects (`dialect.ts:95-98`) | Omit | Like F2. A runtime detection of foreign dialects means that the library does not know what it is running against. |
| F9 Drizzle adapter | pg/mysql/sqlite, transactions **off by default** (`drizzle-adapter.ts:1196`) | Omit | Nobody. The switched-off default makes the registration there non-atomic (inventory N4-51) — an ORM adapter whose default setting lifts a guarantee of the core is worse than no adapter. |
| F10 Prisma adapter | Transactions **off by default** (`prisma-adapter.ts:807-813`) | Omit | Like F9. Prisma moreover demands a schema format of its own alongside the SQL; two descriptions of the same tables drift apart. |
| F11 MongoDB adapter | Document-oriented, `ObjectId` as the ID generator (`mongodb-adapter.ts:865`) | Omit | Like F2. Without foreign keys with `ON DELETE CASCADE` every user deletion would have to pull its sessions, identities and artefacts along in the code — the error class from which GHSA-2vg6-77g8-24mp originates. |
| F12 Memory adapter | In-memory for tests and prototypes (`memory-adapter.ts`) | Solve differently | Tests run against real PostgreSQL; `@velve/auth/testing` delivers clock control and deterministic randomness instead. A second data store for tests does not check what runs in production — unique indexes, CHECK constraints and `ON CONFLICT` do not exist there. |
| F13 Build an adapter of one's own | `createAdapterFactory` + `CustomAdapter` (`db/adapter/factory.ts:55-60`) | Solve differently | The `Driver` interface has two methods; whoever wants to connect a further Postgres driver implements them. No adapter framework with field type mapping, where translation and atomic fallbacks. |
| F14 Adapter test suite | Reusable conformance tests (`packages/test-utils/src/adapter/`) | Solve differently | A driver conformance suite in `@velve/auth/testing` that checks only the two methods — essentially parameter binding, type return and transaction nesting. |
| F15 Core schema `user` | 7 columns, `order:1` (`get-tables.ts:198-246`) | Solve differently | See E1: different columns, `email` nullable, identity rule as a CHECK constraint, normalisation checked afterwards by CHECK. |
| F16 Core schema `session` | 8 columns, FK on `user` with `ON DELETE CASCADE` (`get-tables.ts:130-195`) | Solve differently | `token_sha256 bytea UNIQUE` instead of a plaintext token, two lifetimes instead of one, `factors text[]`, `ip inet`, plus `session_sweep_idx` on `absolute_expires_at`. |
| F17 Core schema `account` | 13 columns, tokens with `returned:false` (`get-tables.ts:251-341`) | Solve differently | Split into `velve.identity` (with `UNIQUE (provider, subject)` and encrypted tokens) and `velve.password_credential` (PHC string). Carrying passwords and foreign identities in the same table is the reason why Better Auth needs `providerId:"credential"` as a special value. |
| F18 Core schema `verification` | 6 columns, `identifier` indexed, not unique (`get-tables.ts:89-128`) | Solve differently | `velve.one_time_token` with `token_sha256` as the primary key and `purpose` — no generic identifier/value store in which 2FA challenges, reset tokens, magic links, OTP counters and trust records lie side by side. Purpose binding is part of the consumption predicate (section 3.7). |
| F19 Optional schema `rateLimit` | Only with `rateLimit.storage:"database"` (`get-tables.ts:60-84`) | Adopt | `velve.rate_bucket` is always present, because the database is mandatory anyway and there is no second store. |
| F20 Compute the schema from the config | `getAuthTables` builds the logical schema anew at every start (`get-tables.ts:369`) | Omit | Nobody. The schema is static and lies as a versioned SQL file in the package; the only branch is the identity CHECK that the first migration sets. A schema recomputed at every start is the cause of the missing version contract (inventory N4-52). |
| F21 Merge plugin schemas | New tables **and** new columns on core tables (`get-tables.ts:30-57`) | Solve differently | Plugins create exclusively tables of their own with the prefix `<plugin-id>_` in the schema `velve`; core tables remain unchanged (section 3.11). Thereby no plugin can shadow a core field — in Better Auth that is unintentionally possible through the order of the object spreads. |
| F22 Physical schema normalisation | Resolves `fieldName`, `references.model` and index names (`db/get-schema.ts:6-56`) | Omit | Nobody; there is no mapping that would have to be resolved (E9/E10). |
| F23 Field types | `string`, `number`, `boolean`, `date`, `json`, `string[]`… (`core/src/db/type.ts:164-171`) | Surpass | No type abstraction but the real PostgreSQL types: `uuid`, `timestamptz`, `bytea`, `inet`, `text[]`, `jsonb`, plus CHECK constraints and partial unique indexes. Better Auth can do none of that (inventory N4-45/46) and puts `string[]` down as a JSON string in `jsonb` (N4-47). |
| F24 `bigint` flag | Generates `bigint` instead of `integer` (`get-tables.ts:77`) | Omit | Removed with F23; the type stands in the SQL. |
| F25 Field indexes | `index: true` / `unique: true` at field level (`type.ts:248,278`) | Omit | Removed with F23; indexes stand as `CREATE INDEX` in the migration step, including partial indexes, which the flag cannot express at all. |
| F26 Table indexes | `indexes: [{fields, name?, unique?}]` (`type.ts:286-293`) | Omit | Like F25. Composite indexes stand as `CREATE INDEX` with written-out columns in the migration step; an `indexes` array can do neither `WHERE` nor expressions. |
| F27 Index name assignment | `<table>_<fields>_idx` with FNV-1a truncation to 63 bytes (`database-index.ts:52-86,250-351`) | Omit | Like F25. Names are written out and stable; a hash truncation generates names that nobody recognises again in an `EXPLAIN`. |
| F28 Index length budget for MySQL/MSSQL | Computes `varchar(N)` from index byte limits (`database-index.ts:202-242`) | Omit | Removed with F2. PostgreSQL needs no `varchar(N)` for `text` that would have to be back-calculated from an index byte budget. |
| F29 `transform.input` / `transform.output` | Field-level transformations on every write/read path (`factory.ts:251-253,354-378`) | Omit | Nobody. Normalisation lies at exactly one place in the core (section 3.4) and is checked afterwards by the database; invisible transformations on every path make it impossible to follow what actually stands in the column. |
| F30 `returned: false` | Hides a field from all responses (`db/schema.ts:60-66`) | Solve differently | The output type of every route stands in the route declaration (section 3.12); confidential values do not leave the repositories in the first place, instead of being filtered out at the end. A forgotten flag is a leak in Better Auth, here a type error. |
| F31 `input: false` | Takes a field out of the input schema (`db/to-zod.ts:23-25`) | Solve differently | The input schema is not derived from the database schema but written in the route declaration. That is why there is no field that accidentally becomes writable (inventory N5-60). |
| F32 CLI `generate` | Generates schema files or SQL (`packages/cli/src/commands/generate.ts`) | Solve differently | `@velve/auth/schema` ships the SQL as a file in the package; it is not generated at runtime and not derived from the configuration. What is shipped is exactly what runs. |
| F33 CLI `migrate` | Executes the plan — only Kysely, not transactional, no history (`cli/src/commands/migrate.ts:53-88`, N4-37/39/40) | Surpass | A versioned migration runner with `velve.schema_migration` (version, name, point in time, checksum), every step in a transaction of its own, part of the library instead of a CLI special route. Plugin migrations run in the same runner (section 3.11). |
| F34 Compute a migration plan | Introspection + diff (`get-migration.ts:584-1235`) | Omit | Nobody. There is no diff but numbered, written steps. A plan generated from a diff cannot rename, delete or retype columns (N4-38) — exactly what one needs migrations for. |
| F35 Programmatic migration | `getMigrations(config)` delivers a plan and `runMigrations()` (`get-migration.ts`) | Adopt | `@velve/auth/schema` exports the runner and a status query, so that migrations can run in the deployment process. |
| F36 "Unsafe change" protection | Refuses mandatory columns without a default on filled tables (`get-migration.ts:1024-1039`) | Solve differently | The safeguard is the checksum in `velve.schema_migration`: a step changed after the fact is recognised at the start. Heuristics about the dangerousness of a change fall away, because the steps are written and checkable. |
| F37 Schema drift check at runtime | `validateSchema` reports deviations with a fix hint (`schema-diff.ts:88-125`) | Solve differently | At the start the highest applied `schema_migration.version` is compared against the one expected by the package; a deviation is a start error, not a warning. Thereby the version contract exists that Better Auth lacks (N4-52). |
| F38 `disableMigration` per table | Takes a plugin table out of the migration and the diff (`core/src/db/plugin.ts:10`) | Omit | Nobody. Migrations are not deselectable; a deselected table is an instance whose schema deviates from the version it claims. |
| F39 Database hooks `user` | `create.before/after`, `update.before/after` (`init-options.ts:1405`) | Solve differently | Over the enumerated points `beforeUserCreate` and `afterUserCreate` (section 3.11) — at the domain operation, not at the CRUD process. A hook may reject or observe, not replace the response. |
| F40 Database hooks `session` | ditto (`init-options.ts:1405`) | Solve differently | Over `beforeSessionCreate`, `afterSessionCreate`, `beforeSessionRevoke`. There is no update hook, because the session is not rewritten but reissued (section 3.5). |
| F41 Database hooks `account` | ditto | Omit | Nobody. There is no extension point at `velve.identity`; the linking rule (section 3.10) is the one place at which identities are decided about, and it is not negotiable. |
| F42 Database hooks `verification` | ditto | Omit | Nobody. One-time artefacts are generated and consumed exclusively by the core; a hook in between would be a way to bypass the atomic consumption. |
| F43 Hook execution | `createWithHooks` / `updateWithHooks` (`db/with-hooks.ts:35-80`) | Adopt | One execution chain, sorted topologically by `dependsOn`; a thrown error aborts the operation (right of veto). |
| F44 Transactions | `adapter.transaction(cb)` by `AsyncLocalStorage`, flat, without savepoints (`core/src/context/transaction.ts:100-164`) | Surpass | `Driver.transaction` is a mandatory component of the driver interface; a driver that cannot do it is not a driver. No `AsyncLocalStorage` context that is passed through with one adapter and not with the next. |
| F45 Use of `runWithTransaction` | Sign-up, `createOAuthUser`, `consumeVerificationValue`, account linking (`sign-up.ts:183` among others) | Adopt | The same places plus session reissue (INSERT + DELETE) and recovery code exchange. |
| F46 Joins | `advanced.database.joins`, default `false` (`factory.ts:628-743`) | Adopt | The session resolution is one query with a join on `velve.user` — without an option. The default `false` means in Better Auth that the most frequent operation of all costs two round trips. |
| F47 Join replacement | Without joins a separate query per relation (`factory.ts:748-828`) | Omit | Nobody; there is no case without a join. |
| F48 Where operators | `eq, ne, lt, …, contains, starts_with` (`db/adapter/index.ts:308-320`) | Omit | Nobody. There is no query abstraction; the SQL of every operation is written and lies in the repository. Thereby the limits of this abstraction also fall away (N4-48/49). |
| F49 Where connectors | `AND`/`OR`, flat, not bracketable (`db/adapter/index.ts:324-343`) | Omit | Like F48. Bracketing and nesting are a matter of course in written SQL; an abstraction that cannot do them forces several queries where one suffices. |
| F50 `mode: "insensitive"` | Case-insensitive matching by `LOWER()`/`ILIKE` (`kysely-adapter/src/query-builders.ts:8-58`) | Solve differently | The comparison form is materialised (`email` normalised, `username_key`), not computed at query time. Only that way does the unique index take hold; a `LOWER()` in the `WHERE` forces a sequential scan and permits duplicates. |
| F51 Sorting | `sortBy: {field, direction}` — exactly one field (`db/adapter/index.ts:422-428`) | Omit | Like F48. The few lists (sessions, identities, passkeys) have their sorting in the written SQL. |
| F52 Limit/offset | `limit`, `offset`, `defaultFindManyLimit` 100 (`factory.ts:1204-1207`) | Omit | Like F48; lists are firmly bounded, because they are small per user. |
| F53 `consumeOne` | Atomic "delete and return" (`db/adapter/index.ts:591-602`) | Adopt | `DELETE … WHERE … AND expires_at > now() RETURNING` is the only consumption pattern for one-time artefacts (section 3.7) — the strongest idea in the Better Auth code, applied here without exception. |
| F54 `incrementOne` | Atomic guarded counter with guard conditions (`db/adapter/index.ts:603-620`) | Solve differently | `INSERT … ON CONFLICT DO UPDATE … RETURNING` in one round trip (section 3.9). Better Auth emulates that with up to four round trips for want of an upsert (inventory N4-42). |
| F55 Atomic fallbacks | Snapshot guard or up to 5 CAS rounds if the adapter has nothing native (`db/adapter/atomic-fallback.ts`) | Omit | Nobody. PostgreSQL can do consumption and upsert natively; a substitute path is the same race, only quieter — exactly the class of CVE-2026-53518 (simultaneous code redemption). |
| F56 `consumeVerificationValue` | Atomic single-use primitive for all one-time tokens (`internal-adapter.ts:1376-1420`) | Adopt | As a `token/` module with exactly one consumption function, bound to `purpose`. |
| F57 `reserveVerificationValue` | Replay tombstone with a deterministic primary key (`internal-adapter.ts:1510-1545`) | Solve differently | The replay protection sits in the primary key itself: `velve.totp_used_step (user_id, time_step)` and `velve.webauthn_challenge (challenge_sha256)`. An `INSERT` that fails on conflict **is** the check — no second artefact that one can forget to create. |
| F58 Verification cleanup | Deletes expired rows at every lookup, switchable off (`internal-adapter.ts:1333-1345`) | Solve differently | Clearing up runs over the `*_sweep_idx` indexes in a callable maintenance function, not on the response path. Expired rows are ineffective anyway, because `expires_at > now()` is part of every predicate; deletion is storage maintenance, not a security measure, and does not belong in the latency of a sign-in. |

**F: Adopt 7 · Solve differently 20 · Omit 28 · Surpass 3**

---

### G. Extensibility (41)

#### G.1 The extension points

| Feature | Better Auth | Velve Auth | Reasoning |
|---|---|---|---|
| G1 Server plugin interface | 16 fields, among others `init`, `middlewares`, `onRequest`, `onResponse`, `adapter` (`core/src/types/plugin.ts:32-163`) | Solve differently | A smaller interface: `id`, `dependsOn`, `routes`, `hooks` (the seven enumerated points), `tables`, `migrations`, `rateLimit`, `errorCodes`. No `init`, no `middlewares`, no `onRequest`/`onResponse`, no `adapter` — a plugin is a listener with a right of veto, not a co-owner of the core (section 3.11). |
| G2 Client plugin interface | `getActions`, `getAtoms`, `pathMethods`, `atomListeners`, `fetchPlugins` (`plugin-client.ts:94`) | Solve differently | Client methods come into being out of the plugin's route declaration, just as the core methods come out of the core's. A plugin delivers no client runtime of its own. |
| G3 Plugin endpoints | Are merged into `auth.api.*`, override core endpoints with the same key (`api/index.ts:177-266`) | Solve differently | Plugin routes lie in the reserved namespace `/x/<plugin-id>/…`; core routes are not overridable (section 3.11). In Better Auth the last registered plugin wins — the ordering trap that `custom-session` hangs on. |
| G4 Endpoint collision detection | Recognises path collisions, **only logs** (`api/index.ts:58-171`) | Surpass | A name conflict is a start error, not a warning (section 3.11). A collision that is only logged is not distinguishable in operation from a functioning system. |
| G5 `serverOnly` endpoints | Endpoint without an HTTP route, partly without a path (`packages/api-key/src/routes/verify-api-key.ts:514`) | Adopt | In the route declaration as `http: false`; a server method comes into being and no route, but the same input check. |
| G6 `metadata.isAction:false` / `scope:"http"` | Hides endpoints from the client type (`types/api.ts:4-17`) | Adopt | The same declaration steers whether a client method comes into being — at one place instead of in two metadata fields. |
| G7 Plugin DB schema | New tables **and** new columns on core tables (`core/src/db/plugin.ts:3-13`) | Solve differently | Only tables of its own with the prefix `<plugin-id>_`, migrations in the same versioned runner; no columns on core tables (section 3.11). |
| G8 Schema renaming by the user | `InferOptionSchema` + `mergeSchema` (`db/schema.ts:280-314`) | Omit | Nobody; there is no name mapping (E9/E10). Incidentally that also removes the fact that `mergeSchema` mutates the passed object in place (`:303,:310`). |
| G9 `plugin.init` | The only way to change the global context and options (`context/helpers.ts:23-95`) | Omit | Nobody. The core context is frozen (`Object.freeze`); a plugin gets no way to change it (section 3.11). `init` is in Better Auth the root of the stripe↔organization coupling and of the haveibeenpwned hijacking. |
| G10 Context injection out of `init` | `{context: {...}}` is mixed in by `Object.assign` (`types/plugins.ts:40-55`) | Omit | Removed with G9. `Object.assign` into the context is the way over which a plugin unnoticed replaces core functions (G24). |
| G11 Option merge out of `init` | `defu(options, restOpts)` (`context/helpers.ts:52`) | Omit | Removed with G9. A plugin may neither read nor write the options of other plugins (section 3.11). |
| G12 `hooks.before` (global) | User hook on arbitrary endpoints (`api/dispatch.ts:271-278`) | Solve differently | The seven enumerated points apply equally to the application and to plugins; there is no hook on an arbitrary endpoint, because such a hook undercuts the guarantees of the route. |
| G13 `hooks.after` (global) | Analogously for the response side (`dispatch.ts:279-286`) | Solve differently | Like G12; the `after` points (`afterSignIn`, `afterSessionCreate`, `afterUserCreate`) observe, they replace nothing. |
| G14 Plugin `hooks.before` | Matcher-based hooks per endpoint (`dispatch.ts:137-219`) | Solve differently | Like G12, with a right of veto: a hook may throw an error and abort the operation. |
| G15 Plugin `hooks.after` | Can catch an `APIError` and replace the response (`dispatch.ts:221-265`) | Omit | Nobody. A hook may not replace the response (section 3.11). Exactly this capability is what the i18n package uses to override error messages — and with it every plugin can rewrite every error response. |
| G16 Context patch out of `before` | The return `{context:{…}}` patches and the chain runs on (`dispatch.ts:194-216`) | Omit | Removed with the frozen context (G9). |
| G17 Short circuit out of `before` | Every other return value becomes the response (`dispatch.ts:215,382-391`) | Solve differently | A hook may reject (throw an error) but not set a success response of its own. The distinction "return value = response" is too easy to trigger accidentally. |
| G18 Replace the response out of `after` | A return value `!== undefined` replaces `context.returned` (`dispatch.ts:257-259`) | Omit | Removed with G15; the rule "`undefined` means unchanged, everything else replaces" is too easy to trigger accidentally (G17). |
| G19 Header/cookie merge out of hooks | `set-cookie` is appended (`dispatch.ts:86-100`) | Omit | Nobody. Cookies are set exclusively by the core; a plugin that may append `set-cookie` can overwrite the session cookie. |
| G20 `plugin.middlewares` | Router middleware with a path pattern, only on the HTTP path (`api/index.ts:197-228`) | Omit | Nobody. One interception model instead of four; the origin check and the rate limiting lie firmly in front of it and also run on direct server calls (section 3.11). |
| G21 `plugin.onRequest` | Can replace the request or hijack the response, only the HTTP path (`api/index.ts:313-330`) | Omit | Like G20. In Better Auth exactly that is the cause of captcha and the SCIM content-type check being ineffective at `auth.api.*` (inventory N3-31). |
| G22 `plugin.onResponse` | Replace the response, only the HTTP path (`api/index.ts:334-352`) | Omit | Like G20. A response that can still be replaced after the handler makes the output type of the route declaration (section 3.12) into a claim. |
| G23 Override a core endpoint | Reassign an endpoint key (`custom-session/index.ts:71`) | Omit | Nobody; it is a start error (G4). |
| G24 Hijack context functions | e.g. replace `ctx.password.hash` (`haveibeenpwned/index.ts:129-150`) | Omit | Nobody. The password verifier, the session resolution and the origin check are expressly not replaceable (section 3.11) — those are the three places at which an error is not noticed. |
| G25 `ctx.getPlugin(id)` / `hasPlugin(id)` | Access to other plugins **and their options** at runtime (`core/src/types/context.ts:313,342`) | Solve differently | `dependsOn` declares the dependency and is resolved topologically; the presence is checkable, the other plugin's options remain unreadable and unwritable. |
| G26 Plugin registry (module augmentation) | `BetterAuthPluginRegistry` makes `getPlugin("two-factor")` typed (`context.ts:82`) | Adopt | The same type bridge, hung on `dependsOn` instead of on a global registry interface. |
| G27 Plugin's own rate limit rules | `rateLimit: [{window, max, pathMatcher}]` (`plugin.ts:148-154`) | Adopt | Rules per route name of the plugin; they run in the same token bucket as the core rules. |
| G28 Plugin's own trusted origins | Append to `trustedOrigins` over `init` (`context/helpers.ts:61-80`) | Omit | Nobody. Origins stand exclusively in the application's configuration. A plugin that may add origins extends the CSRF boundary — in Better Auth `expo` does exactly that. |
| G29 Plugin error codes | `$ERROR_CODES` land in `auth.$ERROR_CODES` (`types/plugins.ts:28-33`) | Adopt | Unchanged; codes are part of the plugin's route declaration. |
| G30 Base error codes | 18 documented codes (`docs/content/docs/reference/errors/`) | Adopt | Stable codes for the visible error class; the invisible class has by definition no code of its own (section 3.13). |
| G31 `$Infer` type bridge | Plugin types land in `auth.$Infer` (`types/auth.ts:21-30`) | Adopt | Unchanged, derived from the route declaration instead of from a free type field. |
| G32 Client type inference from server plugins | Endpoints → client methods, schema → fields (`client/types.ts:28-134`) | Adopt | Same effect, but generated out of a single declaration instead of derived from the endpoint object. |
| G33 Path→object mapping in the client | `/two-factor/verify-totp` → `client.twoFactor.verifyTotp` by a runtime proxy (`client/path-to-object.ts`, `proxy.ts:36-125`) | Surpass | The assignment stands in the route declaration, there is no runtime proxy. A client call that does not exist does not compile — in Better Auth the proxy sends off every path, and type safety exists only at compile time (inventory N7-77). |
| G34 `getActions` (client) | Own client methods, `defu` merge, the first plugin wins (`client/config.ts:177-184`) | Omit | Nobody; the client comes into being entirely out of the declaration. A merge in which "the first plugin wins" is a silent name collision. |
| G35 `getAtoms` (client) | nanostores atoms become `use<Name>` hooks (`client/config.ts:149-151`) | Omit | The application takes it over; the client carries no state (B46). |
| G36 `pathMethods` (client) | Forces HTTP methods per path instead of the body heuristic (`client/config.ts:152-154`) | Surpass | The method stands in the declaration. The heuristic "body present → POST" (`client/proxy.ts:12-34`), which `pathMethods` has to correct, does not exist. |
| G37 `atomListeners` (client) | Signal recallers that invalidate atoms (`client/config.ts:155-157`) | Omit | Removed with G35; without atoms there is nothing to invalidate, and the application's data layer knows its own signals. |
| G38 `fetchPlugins` (client) | better-fetch plugins per client plugin (`client/config.ts:52-92`) | Omit | Nobody. The client takes in a `fetch` implementation; a plugin chain in the transport is the place at which D18 becomes possible. |
| G39 Direct server call `auth.api.*` | Call endpoints without HTTP; runs only through `hooks.before/after` (`api/to-auth-endpoints.ts:74-118`) | Surpass | The server method stems from the same declaration and runs through the same chain **including** the origin check and the rate limiting (section 3.11). The asymmetry that in Better Auth defeats captcha and SCIM checks does not exist. |
| G40 `auth.$context` | Access to the adapter, cookies and secret for plugins and tests (`auth/base.ts:110-120`) | Omit | Nobody. A public access to the internal context makes every restriction of the plugin interface ineffective; what tests need is delivered by `@velve/auth/testing`. |
| G41 Two entrypoints | `better-auth` (with Kysely) and `better-auth/minimal` (`auth/full.ts:27-31`) | Solve differently | One package with subpath exports (section 3.1). Two entry points that differ in their dependencies are two products with one version number. |

**G.1: Adopt 8 · Solve differently 10 · Omit 19 · Surpass 4**

#### G.2 Plugin by plugin

Express requirement of the client: every plugin gets a row of its own. This table
is a **decision per package** and is counted separately in section 2.N — the features of the
plugins themselves are already contained in A–M and are not counted twice here.

**26 plugins in the main package** (`packages/better-auth/src/plugins/`)

| Plugin | Better Auth | Velve Auth | Reasoning |
|---|---|---|---|
| `two-factor` | TOTP, OTP, backup codes, trusted device, intermediate state (`plugins/two-factor/`) | Solve differently | The intermediate state between password and factor is part of the session model and cannot be retrofitted — TOTP, WebAuthn and recovery codes lie in the core (`core/factor/`, section 3.6). OTP over email and trusted device are dropped (D9, D23). |
| `username` | An additional column `user.username` + a sign-in route of its own (`plugins/username/`) | Solve differently | One of the three core identity configurations with `username`/`username_key` and a CHECK constraint (section 3.4), not a plugin that hangs a column onto the user table. |
| `organization` | Organisations, members, invitations, teams, dynamic roles, 44 features (`plugins/organization/`) | Omit | The application takes it over. Roles, permissions, organisations and teams are expressly not the library's task (section 3.14). The plugin is moreover the source of the only real core coupling in Better Auth (`api/middlewares/authorization.ts:91-155`) and of CVE-2026-53514. |
| `access` | Library for statements and roles (`plugins/access/`) | Omit | The application takes it over. A permission vocabulary belongs in the application's domain; an auth library that ships it also defines the application's data model. |
| `admin` | User management, roles, ban, impersonation (`plugins/admin/`) | Omit | The application takes it over. Velve Auth provides `disabled_at` and the session revocations; who may set them is a permission question. An admin API without a permission model is an unprotected API. |
| `anonymous` | Guest accounts with a placeholder email (`plugins/anonymous/`) | Omit | The application takes it over (D50). A guest is not a user with an invented address. |
| `bearer` | Bearer token → session cookie, `requireSignature` default `false` (`plugins/bearer/index.ts:78-85`) | Solve differently | `auth.session.resolve(token)` takes the token directly (B45); there is no header-to-cookie rewriting and no mode that accepts unsigned tokens. |
| `captcha` | Turnstile/reCAPTCHA/hCaptcha/CaptchaFox as `onRequest` (`plugins/captcha/`) | Omit | The application takes it over (A50). Implemented as `onRequest` it would be ineffective on server calls, and `onRequest` does not exist. |
| `custom-session` | Replaces the core endpoint `/get-session` (`plugins/custom-session/index.ts:71`) | Omit | The application takes it over, after the call. Core routes are not overridable; a plugin whose core is precisely the overriding cannot exist (G3/G23). |
| `device-authorization` | RFC 8628 device flow (`plugins/device-authorization/`) | Omit | Nobody in the core; a plugin can build it under `/x/…`. The device flow presupposes that Velve Auth acts as an authorisation server — it does not do that (section 3.14). CVE-2026-45337 moreover shows that the owner binding is the actual content of this flow. |
| `email-otp` | OTP by email for login, verification, reset, change; `storeOTP` default `plain` (`plugins/email-otp/index.ts:42`) | Omit | A plugin takes it over. A code by email is functionally a magic link with worse entropy; Velve Auth offers the magic link in the core (D48) and never stores it in plaintext. Moreover this path was part of GHSA-qq9h-g4jm-xgf3. |
| `generic-oauth` | Arbitrary OAuth2/OIDC providers at runtime (`plugins/generic-oauth/`) | Adopt | As a core component instead of as a plugin (C47), without the possibility of shadowing built-in providers. |
| `haveibeenpwned` | Replaces `ctx.password.hash`, checks against HIBP (`plugins/haveibeenpwned/`) | Omit | The application takes it over (A49). The plugin's mechanism — hijacking the hash function — is expressly forbidden (section 3.11). |
| `jwt` | JWKS endpoint, JWT output, JWT cookie cache signer (`plugins/jwt/`) | Omit | The application takes it over. Sessions are opaque database rows; whoever needs a JWT for a downstream service issues it out of the resolved session itself. The cookie cache signer is removed with B23. |
| `last-login-method` | Non-httpOnly cookie with the last method (`plugins/last-login-method/index.ts:186`) | Omit | The application takes it over (E27). |
| `magic-link` | Login by an email link, `storeToken` default `plain` (`plugins/magic-link/index.ts:163`) | Adopt | As a core component with `purpose='magic_link'`, lifetime 10 min, stored exclusively as `sha256(token)` (D48/D49). |
| `multi-session` | Several accounts per device over a fan of cookies (`plugins/multi-session/`) | Omit | The application or a plugin takes it over (B36). The core knows exactly one session cookie. |
| `oauth-popup` | Replaces the callback redirect by `postMessage` to the opener (`plugins/oauth-popup/`) | Omit | The application takes it over (C96). The mechanism passes the session token out of the `set-cookie` header on to a foreign window. |
| `oauth-proxy` | Callbacks over a fixed production URL to preview URLs (`plugins/oauth-proxy/`) | Omit | Nobody (C95). By design a bypassing of the origin binding. |
| `one-tap` | Google One Tap over `id_token` (`plugins/one-tap/`) | Omit | Nobody (D47); presupposes the direct ID token entry, which does not exist. |
| `one-time-token` | Session transfer by a one-time token, default `plain` (`plugins/one-time-token/index.ts:76,106`) | Omit | The application takes it over (B44). An artefact whose value is a session token doubles the session's attack surface. |
| `open-api` | OpenAPI schema + a Scalar reference page from an external CDN (`plugins/open-api/index.ts:65`) | Solve differently | The OpenAPI document is generated out of the route declaration and is a core component (H51); the reference page is dropped, because the library renders no HTML and loads no foreign script (H52). |
| `phone-number` | Telephone number as an identity + OTP, registration with a placeholder email (`plugins/phone-number/`) | Omit | A plugin takes it over (E25/E26). |
| `siwe` | Sign-In with Ethereum (`plugins/siwe/`) | Omit | A plugin takes it over (D44). Routes of its own under `/x/siwe/…` and a table of its own suffice for that. |
| `test-utils` | Puts test helpers into the production context (`plugins/test-utils/`) | Solve differently | `@velve/auth/testing` is a subpath export of its own (section 3.1), not a plugin. A plugin that "may never be loaded in production" is a plugin that will at some point be loaded in production. |
| `additional-fields` (client only) | Type inference for `user`/`session` additional fields (`plugins/additional-fields/client.ts`) | Omit | Nobody; there are no additional fields on core tables (E5–E8), so nothing to infer. |

**12 external packages**

| Package | Better Auth | Velve Auth | Reasoning |
|---|---|---|---|
| `@better-auth/passkey` | WebAuthn as a package of its own, `attestationType: "none"`, `requireUserVerification: false` (`packages/passkey/`) | Solve differently | In the core instead of as a package, with `userVerification: "required"` and BE/BS evaluation (D33/D43). A sign-in method of its own does not belong in a package that one can forget to install. |
| `@better-auth/api-key` | API keys with rate limit, refill, permissions; a `before` hook fabricates a session (`packages/api-key/src/index.ts:169-269`) | Omit | The application takes it over. API keys are machine identities, not "who is signed in"; the plugin's mechanism — an invented session with the plaintext key as the token (`:245`) — is irreconcilable with the session model. GHSA-99h5-pjcv-gr6v / CVE-2025-61928 (CVSS 8.6) concerned this feature, at that time still in the core package `better-auth` < 1.3.26. |
| `@better-auth/sso` | OIDC and SAML2 service provider per domain/organisation (`packages/sso/`) | Omit | The application or a dedicated product takes it over. No SAML, no SSO (section 3.14). Four of the most severe advisories fall to this one package: GHSA-5rr4-8452-hf4v (CVSS 9.6, SSRF), GHSA-gv74-j8m3-fg5f, GHSA-prpr-5gj3-qqhg, GHSA-8c5h-wx78-2cfg. |
| `@better-auth/oauth-provider` | A complete OAuth 2.1/OIDC authorisation server, 7 tables (`packages/oauth-provider/`) | Omit | Nobody. Velve Auth answers who is signed in; being an authorisation server is the reverse role with a threat situation of its own (section 3.14). The largest attack surface in the Better Auth repository, with CVE-2026-53517 and CVE-2026-53518. CVE-2026-53512 and GHSA-9h47-pqcx-hjr4 by contrast concern the predecessor plugins `oidcProvider`/`mcp` in the package `better-auth` < 1.6.11, not this package. |
| `@better-auth/mcp` | MCP resource server, decorates `oauthProvider()` (`packages/mcp/src/plugin.ts:170-224`) | Omit | Nobody; presupposes the authorisation server. Expressly excluded. |
| `@better-auth/scim` | SCIM 2.0 provisioning, 7–9 tables (`packages/scim/`) | Omit | The application or a dedicated product takes it over. No SCIM (section 3.14). Affected by GHSA-rjg6-39jm-rgg4 (CVSS 9.9) and GHSA-j8v8-g9cx-5qf4. |
| `@better-auth/stripe` | Subscriptions, customers, seats, webhooks; mutates the options of the organization plugin (`packages/stripe/src/index.ts:256`) | Omit | The application takes it over. No subscription/payment module (section 3.14). The mechanism — one plugin writes into the options of another — is expressly forbidden (section 3.11). |
| `@better-auth/expo` | Expo/React Native: overrides the `origin` header, appends `set-cookie` as a query parameter to deep links (`packages/expo/src/index.ts:36-102`) | Omit | The application takes it over. Both core mechanisms of the package — origin override and cookie-in-the-query-parameter — are irreconcilable with the origin check and the cookie model. Native applications run over the authorisation code flow in the system browser. |
| `@better-auth/electron` | Desktop login over the system browser, `transfer_token` cookie (`packages/electron/`) | Omit | The application takes it over, after the same pattern (RFC 8252, PKCE, a redirect handler of its own). The library delivers `genericOAuth` and `session.resolve` for it, it needs no desktop package. |
| `@better-auth/i18n` | Translates `APIError` messages over an `after` hook with `matcher: () => true` (`packages/i18n/src/index.ts:155-183`) | Solve differently | The library delivers stable error codes instead of prose texts; translation happens in the application (H53). The package's mechanism — a hook that intercepts and replaces every response — does not exist (G15). |
| `@better-auth/redis-storage` | `SecondaryStorage` implementation for Redis (`packages/redis-storage/`) | Omit | Nobody. No secondary storage (B32); the database is the only place for session state. |
| `@better-auth/cimd` | Client ID metadata document resolution for MCP/OAuth (`packages/cimd/`) | Omit | Nobody; presupposes the authorisation server. |

**Plugin decisions: Adopt 2 · Solve differently 7 · Omit 29** (38 packages, counted separately)

---

### H. Operation and cross-cutting concerns (57)

| Feature | Better Auth | Velve Auth | Reasoning |
|---|---|---|---|
| H1 Rate limiting globally | An `onRequest` hook before every endpoint logic; `enabled` = `isProduction` (`api/rate-limiter/index.ts`) | Surpass | Always active, in development too, and always before the route logic — on direct server calls as well (section 3.11). A protection that is off in development is never tested in development. |
| H2 Rate limit defaults | `window` 10 s, `max` 100 (`create-context.ts:354-362`) | Solve differently | A token bucket with a continuous refill rate instead of a fixed window. A fixed window permits double the rate at the window edge. |
| H3 Storage `memory` | Process-local `Map`, capped at 100 000 entries, default (`rate-limiter/index.ts:302-326`) | Omit | Nobody. Process-local counters are ineffective in serverless and multi-instance operation, and Better Auth does not even warn (inventory N7-75). The counter lies in PostgreSQL, which is mandatory anyway. |
| H4 Storage `database` | Table `rateLimit`, race-free over a conditional `incrementOne` (`rate-limiter/index.ts:115-245`) | Surpass | A single `INSERT … ON CONFLICT DO UPDATE … RETURNING` per check (section 3.9). Better Auth emulates the upsert with up to four round trips for want of `ON CONFLICT` in the adapter API (inventory N4-42). |
| H5 Storage `secondary-storage` | Fixed window over `SecondaryStorage.increment` (`rate-limiter/index.ts:280-301`) | Omit | Removed with B32. A fixed window over `increment` moreover permits double the rate at the window edge (H2). |
| H6 Storage `customStorage` | Hook in an implementation of one's own (`init-options.ts:291`) | Omit | Nobody. One store, in the database that is always there; an exchangeable implementation of the rate limiting is an exchangeable security boundary. |
| H7 Endpoint-specific limits | sign-in/sign-up 3/10 s, reset 3/60 s, the rest 100/10 s (`rate-limiter/index.ts:439-468`) | Adopt | The same orders of magnitude, declared per route name. |
| H8 `customRules` | Own rules per path, `false` switches off (`rate-limiter/index.ts:381-407`) | Adopt | Rules per **route name** instead of per path pattern; one can switch off a rule, not the counter. |
| H9 Rate limit key | `` `${ip}\|${path}` `` — no key per account (`core/src/utils/ip.ts:395-399`) | Surpass | Three counters at once: the IP prefix (`/32` or `/64`, CVE-2026-45364), the account as a bucket with a slowly refilling rate — exceedance is a refusal, not a delay and not a lock (L-5) —, and globally per route as an alarm callback instead of as a refusal. The key contains the resolved route name, so that `//sign-in` and `/sign-in` are the same counter (GHSA-x732-6j76-qmhm). |
| H10 IP determination | `x-forwarded-for`, configurable over `ipAddressHeaders` (`utils/ip.ts:346,354-385`) | Solve differently | `X-Forwarded-For` is evaluated only when `trustedProxies` is configured; otherwise the connection address counts (section 3.9). No freely choosable header name — a configurable header is a configurable spoofing channel. |
| H11 `trustedProxies` (CIDR) | Walks the forwarded chain from the right, fail-closed (`utils/ip.ts:317-331`) | Adopt | Adopted unchanged, including the fail-closed handling of malformed hops. |
| H12 `disableIpTracking` | Switches the IP capture off (`init-options.ts:298`) | Adopt | As `sessionMetadata: "none"` (L-10); the default is `"truncated"`. The rate limiting then works on further on the connection address without storing it. |
| H13 429 response | Sets `X-Retry-After` instead of `Retry-After` (`rate-limiter/index.ts:94-107`) | Solve differently | `Retry-After` per RFC 9110, so that clients and intermediate layers can evaluate the value at all. |
| H14 Cookie naming scheme | `session_token`, `session_data`, `account_data`, `dont_remember`, `state`, `oauth_state` (`cookies/index.ts:119-154`) | Solve differently | Two cookies: `__Host-velve_session` and `__Host-velve_pending`. No `session_data` (B23), no `account_data` (C94), no `dont_remember` (B14); the OAuth state stands in the database, the cookie holds only a pointer (C52). |
| H15 `advanced.cookiePrefix` | The prefix of all auth cookies freely choosable (`cookies/index.ts:95`) | Omit | Nobody. `__Host-` is not an ornament but the guarantee; a free prefix lifts it. |
| H16 `advanced.cookies[x].name` | Override individual cookie names (`cookies/index.ts:96-98`) | Omit | Like H15. A renamed cookie without a `__Host-` prefix loses the guarantee just as a renamed prefix does. |
| H17 `advanced.cookies[x].attributes` | Override attributes per cookie — wins over everything, `httpOnly` included (`cookies/index.ts:102-114`) | Omit | Nobody. An option with which one can switch `httpOnly` off is an option with which one delivers the session token to JavaScript. |
| H18 `advanced.defaultCookieAttributes` | Global default attributes, e.g. `SameSite=None`, `Partitioned` (`cookies/index.ts:102-114`) | Omit | Like H17. `SameSite=None` is not provided for with `__Host-` and the origin check; in Better Auth no CSRF protection remains in this configuration (inventory N3-23). |
| H19 `useSecureCookies` + `__Secure-` | A four-stage resolution, `__Secure-` with `secure` (`cookies/index.ts:65-75`) | Surpass | `__Host-` enforces `Secure`, forbids `Domain` and binds to `Path=/` — cookie tossing from a subdomain is thereby structurally excluded. Better Auth defines the constant but never uses it (`cookies/cookie-utils.ts:34-35`, inventory N3-22). |
| H20 `crossSubDomainCookies` | `enabled`, `domain`, `additionalCookies` (`cookies/index.ts:76-90`) | Omit | The application takes it over, over a common origin or a token handover of its own. `__Host-` forbids `Domain`; subdomain-wide session cookies trust every subdomain, the forgotten one too. |
| H21 Cookie signing | HMAC-SHA256 over the value with `ctx.secret` (`better-call dist/crypto.mjs:21-31`) | Solve differently | The session cookie carries a 256 bit random token whose validity is decided exclusively by the database — a signature would be ineffective and would suggest integrity where existence counts. Signing happens only where a pointer has to stay intact, with the HKDF-derived key `cookie-sig`. |
| H22 `getSessionCookie` helper | Reads the session cookie outside the handler (`cookies/index.ts:579-586`) | Adopt | Adopted, with the express note that the presence of a cookie is not an authentication. |
| H23 `trustedOrigins` static | A list of permitted origins (`auth/trusted-origins.ts`) | Adopt | As `origins: [...]`; a mandatory statement without a default. |
| H24 `trustedOrigins` dynamic | A function per request (`init-options.ts:1383`) | Omit | Nobody. A function per request makes the CSRF boundary dependent on application code that in the error case permits everything; tenants enter their origins into the list. |
| H25 `trustedOrigins` wildcards | `*.example.com`, protocol-specific and protocol-agnostic (`trusted-origins.ts:125-138`) | Omit | Nobody. Only exact origins. Prefix and wildcard comparisons were the project's most productive source of errors: GHSA-36rg-gfq2-3h56 (`startsWith`), GHSA-vp58-j275-797x (token exfiltration), CVE-2025-27143 (`//evil.com`). |
| H26 Custom schemes | `myapp://`, `chrome-extension://`, `exp://**` by string decomposition instead of `new URL()` (`trusted-origins.ts:32-73`) | Solve differently | Non-HTTP schemes are entered as a complete, exact origin and compared as such; no string decomposition of one's own and no `**`. A self-built URL parser alongside the built-in one is a parser differential (cf. GHSA-prpr-5gj3-qqhg). |
| H27 Redirect URL validation | Rejects `//`, `\`, control characters, `%2f` (`trusted-origins.ts:14-105`) | Solve differently | Complete URLs are not taken in at all: `redirect_path` is a path, held server-side (section 3.10). What one does not take in one does not have to validate — five advisories of this class (no. 1, 3, 4, 5, 25 in the security report) could not have arisen that way. |
| H28 `originCheckMiddleware` | Origin/referer check on all non-GET routes with a cookie (`origin-check.ts:67-151`) | Adopt | Adopted and tightened: it also runs on direct server calls and is not switchable off. |
| H29 `Origin: null` special case | Reconstructs the origin with `Sec-Fetch-Site: same-origin` (`origin-check.ts:253-269`) | Adopt | Unchanged; necessary for redirect chains and sandbox frames. |
| H30 Callback URL validation | `callbackURL`, `redirectTo`, `errorCallbackURL`, `newUserCallbackURL` against `trustedOrigins` (`origin-check.ts:83-150`) | Solve differently | Four parameters with URL semantics become one path parameter (H27). Every additional URL parameter is a further place at which the validation can be forgotten — CVE-2024-56734 was exactly that. |
| H31 `advanced.disableCSRFCheck` | Switches the CSRF check off (`create-context.ts:397`) | Omit | Nobody. The check is part of the fixed chain in front of every route (section 3.11) and knows no switch. Whoever wants to switch it off has in practice a missing origin in the list — that is fixed there, not at the check; and a switch that is thrown in development stays thrown in production. |
| H32 `advanced.disableOriginCheck` | Switches the URL validation off, and out of compatibility CSRF too (`create-context.ts:398-403`) | Omit | Nobody. An option that switches two checks off at once although its name names only one is the reason why it may not exist. |
| H33 `advanced.trustedProxyHeaders` | Trusts `X-Forwarded-Host`/`-Proto` in the baseURL determination (`init-options.ts:500`) | Omit | Nobody. The base URL is configuration. Trusting `X-Forwarded-Host` on the first request was CVE-2025-71401: an external request poisoned the base path permanently. |
| H34 `advanced.skipTrailingSlashes` | Tolerates deviating trailing slashes (`init-options.ts:534`) | Solve differently | Paths are normalised before the resolution, and the key for rate limiting and rules is the resolved route name — not the raw path. Tolerance as an option is the cause of GHSA-x732-6j76-qmhm. |
| H35 `secret` | One secret for cookie signatures, email JWTs and the cookie cache (`init-options.ts:603`) | Solve differently | One root key, out of it by HKDF-SHA256 six purpose-separated keys: `cookie-sig`, `token-pepper`, `totp-enc`, `oauth-token-enc`, `pkce-enc`, `password-enc` (section 3.8, L-2). Better Auth has no domain separation; HKDF only in the JWE path (inventory N3-27). |
| H36 `secrets` (versioned) | Rotation over `[{version, value}]`, but only for encryption (`init-options.ts:616`, N3-26) | Surpass | Every generated value carries its key version, a ring of accepted versions permits rotation without an outage — for **all** purposes, not only for encryption. And because sessions are opaque database rows, every rotation survives all sessions. |
| H37 Envelope format `$ba$<v>$<hex>` | Encrypted values carry their key version (`crypto/index.ts:16-98`) | Adopt | The same principle; the version stands additionally as a column of its own (`key_version`, `token_key_version`), so that it is evaluable without parsing. |
| H38 Lazy re-encryption | Old envelopes are lifted at the next write (`context/secret-utils.ts:75-167`) | Adopt | Unchanged; the same pattern as with the silent rehash. |
| H39 Secret entropy check | Warns on a weak secret, throws on the default secret in production (`create-context.ts:46-72`) | Adopt | Adopted as a start error on a too-short root key — there is no default root key that would have to be warned about. |
| H40 `logger` | A logger of one's own with level control (`init-options.ts:1399`) | Adopt | Unchanged. Server-side, the true reason for every invisible refusal is logged (section 3.13). |
| H41 `onAPIError` | Central error callback with `throw`, `onError`, `errorURL` (`init-options.ts:1698`) | Solve differently | An error callback without an `errorURL` variant, because there is no error page rendered by the library and no error redirect (A52). |
| H42 `disabledPaths` | Switch individual endpoints off on the HTTP side (`api/index.ts:296-301`) | Omit | Nobody. Which routes exist follows from the configuration — identity configuration, activated factors, provider list. A subsequent switch-off list is a second truth about the surface, and it was involved in GHSA-x732-6j76-qmhm. |
| H43 `basePath` | Mount point of the API, default `/api/auth` (`init-options.ts:579`) | Adopt | Unchanged. |
| H44 `baseURL` static | A fixed public URL (`init-options.ts:571`) | Adopt | A mandatory statement instead of an option with derivation. |
| H45 `baseURL` dynamic | A function per request, the context is cloned per request (`auth/base.ts:64-73`) | Omit | Nobody. One base URL per instance; a context cloned per request makes every statement about "the" context invalid. |
| H46 `appName` | Display name for the TOTP issuer and OpenAPI (`init-options.ts:547`) | Adopt | Unchanged, additionally as the WebAuthn `rpName`. |
| H47 `backgroundTasks.handler` | Hand background work to `waitUntil` or similar (`create-context.ts:409-427`) | Adopt | Necessary: the silent rehash runs after the sending of the response in a bounded background task (section 3.3, step 6), as does the email dispatch. |
| H48 Telemetry | Anonymous init and event telemetry, opt-in (`packages/telemetry/src/index.ts:67-90`) | Omit | Nobody. The library reports nothing to the outside. An authentication library that knows a foreign endpoint in the start path is in need of explanation — even if it does not call it. |
| H49 Telemetry detectors | Runtime, database, framework, system, package manager (`packages/telemetry/src/detectors/`) | Omit | Removed with H48. The detection of runtime, database and framework is a fingerprint; anonymised too, it does not belong in a library that sends nothing. |
| H50 OpenTelemetry instrumentation | Endpoint and database spans (`docs/…/instrumentation.mdx`) | Solve differently | No OTel dependency in the package; the hook-in points are the `logger` and the alarm callback of the global rate limiting, out of which the application generates spans. A library with six core dependencies does not take on an observability SDK. |
| H51 Generate an OpenAPI schema | `GET /open-api/generate-schema` per plugin (`plugins/open-api/`) | Adopt | As a core component: the route declaration is already the complete source (path, method, input, output, error codes), the document is generated out of it instead of derived from running endpoints. |
| H52 API reference page | `GET /reference` renders Scalar from an external CDN (`plugins/open-api/index.ts:65-99`) | Omit | The application takes it over. The library renders no HTML and loads no foreign script into its own origin. Incidentally this route in Better Auth skips all `after` hooks (`dispatch.ts:418-421`). |
| H53 Translate error messages | An `after` hook with `matcher:()=>true` replaces `APIError` messages (`packages/i18n/src/index.ts:155-183`) | Solve differently | The library delivers stable codes; the application translates them. Thereby the hook that may intercept and replace every response falls away (G15). |
| H54 22 bundled languages | ar, bn, de, en, es, fa, fr, hi, id, it, ja, ko, nl, pl, pt, ru, sv, th, tr, uk, vi, zh (`packages/i18n/src/locales/`) | Omit | The application takes it over. Translations that a library ships age with its version, not with the product. |
| H55 Locale detection | `header`, `cookie`, `session`, `callback` (`packages/i18n/src/index.ts:118-148`) | Omit | The application takes it over; it knows its language choice anyway. |
| H56 Test helpers in the context | Login, cookie and factory helpers as a plugin (`plugins/test-utils/`) | Solve differently | `@velve/auth/testing` as a subpath export of its own with clock control and deterministic randomness, not a plugin that can hang itself into the production context. |
| H57 CLI commands (11) | `init`, `generate`, `migrate`, `secret`, `create-admin`, `info`, `upgrade`, `ai`, `login`, `logout`, `mcp` (`packages/cli/src/index.ts:24-36`) | Solve differently | No CLI. What is needed are programming interfaces: `@velve/auth/schema` (migration runner, status query) and `@velve/auth/import`. Of the eleven commands, `create-admin` is dropped for want of a role model, `login`/`logout`/`mcp`/`ai` bind to the paid service, `generate`/`migrate` become a library function, `secret` is a one-liner with `crypto.getRandomValues`. |

**H: Adopt 17 · Solve differently 15 · Omit 20 · Surpass 5**

---

### I. Authorisation and organisations (71)

The entire section is dropped. Velve Auth answers exactly one question — who is signed in.
Roles, permissions, organisations, teams, invitations, SCIM and SSO are expressly not
the library's task (section 3.14). Whoever needs them builds them in the application on
`user_id` and the session data or deploys a dedicated product. The reasoning per
row names why the capability is better placed there.

#### I.1 Access control library (5)

| Feature | Better Auth | Velve Auth | Reasoning |
|---|---|---|---|
| I1 `createAccessControl(statements)` | Defines the statement vocabulary (`plugins/access/access.ts:157-169`) | Omit | The application takes it over. The vocabulary describes the application's domain; an auth library that prescribes it also determines the application's modelling. |
| I2 `newRole(statements)` | Generates a role as a subset (`access.ts:157-169`) | Omit | The application takes it over; roles are application data. |
| I3 `role.authorize(request, connector)` | Checks a permission request in memory (`access.ts:106-155`) | Omit | The application takes it over. An in-memory check with no relation to the database cannot make a statement about the current state. |
| I4 Connector `AND` / `OR` | `AND` default, `OR` optional (`access.ts:87-104`) | Omit | The application takes it over; connective semantics belong to the rule, not to the library. |
| I5 Default statements organization | `organization[…]`, `member[…]`, `invitation[…]`, `team[…]` (`organization/access/statement.ts:3-41`) | Omit | The application takes it over. A bundled vocabulary for organisations presupposes that organisations exist — here they do not. |

#### I.2 Organization plugin (54)

| Feature | Better Auth | Velve Auth | Reasoning |
|---|---|---|---|
| I6 Create an organisation | `POST /organization/create` | Omit | The application takes it over. An organisation is an object of its domain: which fields it has, who may create it and what its deletion does to the application's data is known only to the application. Velve Auth delivers `user_id` and `session.factors` for that, nothing else (section 3.14). All rows that refer to I6 are read or write accesses to this object. |
| I7 Update an organisation | `POST /organization/update` | Omit | Like I6; which fields are changeable is a question of the application's data model. |
| I8 Delete an organisation | `POST /organization/delete` | Omit | Like I6; the deletion semantics hang on the application's data, not on the identity. |
| I9 List organisations | `GET /organization/list` | Omit | Like I6; a list is a query over a table that belongs to the application. |
| I10 Read a single organisation | `GET /organization/get-organization` | Omit | Like I6; a read access to an application table needs no route in the sign-in library. |
| I11 Full picture of an organisation | `GET /organization/get-full-organization` | Omit | Like I6; an aggregate over six tables is a query of the application. |
| I12 Set the active organisation | `POST /organization/set-active` writes `session.activeOrganizationId` | Omit | The application takes it over. An application state in the session row is exactly the foreign column on a core table that is not supposed to exist (E6). |
| I13 Check slug availability | `POST /organization/check-slug` | Omit | Like I6. Slugs are application identifiers, and their availability check is as enumerable as E21 — only here the application limits it itself. |
| I14 Invite a member | `POST /organization/invite-member` | Omit | The application takes it over, over its own email dispatch. An invitation connects an address with a membership, not with an identity — and exactly that confusion was CVE-2026-53514 (I15). All rows that refer to I14 are state transitions of this application object. |
| I15 Accept an invitation | `POST /organization/accept-invitation` | Omit | The application takes it over. Better Auth's implementation accepted email equality as proof of ownership (CVE-2026-53514) — the error arises where identity and membership are mixed. |
| I16 Reject an invitation | `POST /organization/reject-invitation` | Omit | Like I14; rejecting is a state change on an object of the application. |
| I17 Cancel an invitation | `POST /organization/cancel-invitation` | Omit | Like I14; the same object, the same responsibility — only from the inviting side. |
| I18 Read an invitation | `GET /organization/get-invitation` | Omit | Like I14. Who may read an invitation decides who knows the link — a permission question. |
| I19 List an org's invitations | `GET /organization/list-invitations` | Omit | Like I14; lists over invitations are queries of the application. |
| I20 List one's own invitations | `GET /organization/list-user-invitations` | Omit | Like I14; the invited user's view is an application view over `user_id`. |
| I21 `invitationExpiresIn` | Validity period of the invitation (`types.ts:184`) | Omit | Like I14; a lifetime for an object that does not exist. |
| I22 `invitationLimit` | Caps open invitations (`types.ts:190`) | Omit | Like I14; an upper bound is a business rule (I33). |
| I23 `cancelPendingInvitationsOnReInvite` | Cancels old invitations (`types.ts:206`) | Omit | Like I14; whether a renewed invitation replaces the old one is process semantics of the application. |
| I24 `requireEmailVerificationOnInvitation` | Demands a verified email in order to accept (`types.ts:229`) | Omit | Like I14. That this check was optional is the core of CVE-2026-53514. |
| I25 List members | `GET /organization/list-members` | Omit | Like I6; the member list is a join of the application on `velve.user`. |
| I26 Remove a member | `POST /organization/remove-member` | Omit | Like I6. Who may be removed is a permission question; the removed person's sessions remain untouched by it, for membership is not an identity. |
| I27 Change a member's role | `POST /organization/update-member-role` | Omit | The application takes it over; roles are application data. |
| I28 Read the active member | `GET /organization/get-active-member` | Omit | Like I12; without an active organisation in the session there is no "active member", only a user and the application's memberships. |
| I29 Read the active member's role | `GET /organization/get-active-member-role` | Omit | Like I12; the role is read by the application out of its own table. |
| I30 Leave an organisation | `POST /organization/leave` | Omit | Like I6; leaving is one row fewer in an application table. |
| I31 Multiple roles per member | `member.role` as a comma-separated string (`api/middlewares/authorization.ts:100-105`) | Omit | The application takes it over — and models multiple roles as rows, not as a comma-separated string in a text column. |
| I32 `creatorRole` | The creator's role, default `owner` (`types.ts:59`) | Omit | Like I27; which role the creator gets is a rule of the application. |
| I33 `membershipLimit` | Maximum member count (`types.ts:67`) | Omit | Like I6; a business rule. |
| I34 `organizationLimit` | Maximum organisations per user (`types.ts:50`) | Omit | Like I33; the limit counts objects that the library does not know. |
| I35 `allowUserToCreateOrganization` | Who may create organisations (`types.ts:32`) | Omit | Like I33; a permission decision. |
| I36 Activate teams | `teams.enabled` generates `team`/`teamMember` (`types.ts:108-112`) | Omit | Like I6. Teams are second-level organisations — the same tables, one level deeper — and share their reasoning; the rows I37–I44 and I46 are their read and write accesses. |
| I37 Create a team | `POST /organization/create-team` | Omit | Like I36; an insert into an application table. |
| I38 Update a team | `POST /organization/update-team` | Omit | Like I36; see I7 for the fields. |
| I39 Delete a team | `POST /organization/remove-team` | Omit | Like I36; see I8 for the deletion semantics. |
| I40 List teams | `GET /organization/list-teams` | Omit | Like I36; a query of the application. |
| I41 Add a team member | `POST /organization/add-team-member` | Omit | Like I36. Who may add is a permission question (I26). |
| I42 Remove a team member | `POST /organization/remove-team-member` | Omit | Like I36; the counterpart to I41, the same permission question. |
| I43 List team members | `GET /organization/list-team-members` | Omit | Like I36; a join of the application on `velve.user` (I25). |
| I44 List one's own teams | `GET /organization/list-user-teams` | Omit | Like I36; the user's view of his memberships, over `user_id`. |
| I45 Set the active team | `POST /organization/set-active-team` writes `session.activeTeamId` | Omit | Like I12; `activeTeamId` would be the second application column on the session row. |
| I46 `teams.defaultTeam` | Automatically creates a default team (`types.ts:116`) | Omit | Like I36; an automatically created default team is a default over application data. |
| I47 `teams.maximumTeams` / `maximumMembersPerTeam` | Caps (`types.ts:142,162`) | Omit | Like I33; caps over objects that the library does not know. |
| I48 Dynamic access control | `dynamicAccessControl.enabled` generates `organizationRole` (`types.ts:87`) | Omit | The application takes it over. Roles changeable at runtime are a permission system with a life cycle of its own — that is a product of its own. |
| I49 Create a role at runtime | `POST /organization/create-role` | Omit | Like I48; to create a role means to extend the permission vocabulary at runtime. |
| I50 Update a role | `POST /organization/update-role` | Omit | Like I48; a role change acts on every running permission check whose semantics only the application knows. |
| I51 Delete a role | `POST /organization/delete-role` | Omit | Like I48; deleting a role has to decide what happens to its bearers — an application rule. |
| I52 List roles | `GET /organization/list-roles` | Omit | Like I48; lists are queries of the application. |
| I53 Read a role | `GET /organization/get-role` | Omit | Like I48; single access, the same query. |
| I54 Check a permission | `POST /organization/has-permission` | Omit | The application takes it over. A permission check over HTTP is moreover a round trip at the place at which the application is already standing in its database anyway. |
| I55 `organizationHooks` | Before/after hooks for all organisation processes (`types.ts:363`) | Omit | Like I6 — and the place at which `@better-auth/stripe` writes into foreign plugin options (`stripe/index.ts:256`). |
| I56 `organization.additionalFields` / `schema` | Own fields and name mapping for six tables (`types.ts:293`) | Omit | Like I6; the tables belong to the application, together with their fields. |
| I57 Session extension | `session.activeOrganizationId`, `session.activeTeamId` (`organization.ts:1257-1296`) | Omit | Like I12. The session row carries only what belongs to the answer "who is signed in, and how securely" (section 3.5). |
| I58 `requireOrgRole` middleware | Core middleware that reads the `member` table (`api/middlewares/authorization.ts:91-155`) | Omit | Nobody — expressly. That is the only real core coupling of the organization plugin in Better Auth: the core knows a table that exists only with the plugin. |
| I59 `ac` / `roles` | Hook in an access control object of one's own and roles of one's own (`types.ts:75,79`) | Omit | Like I1; hooking in an access control object of one's own presupposes the bundled one, which does not exist. |

#### I.3 Admin plugin (10)

| Feature | Better Auth | Velve Auth | Reasoning |
|---|---|---|---|
| I60 Create a user | `POST /admin/create-user` | Omit | The application takes it over, over the server method `auth.signUp()` — which exists without an HTTP route (A36/G5). What is missing is only the permission check, and that belongs to the application. |
| I61 List / read / change / delete users | `/admin/list-users`, `/get-user`, `/update-user`, `/remove-user` | Omit | The application takes it over; it has direct access to `velve.user` and its own profile tables. |
| I62 Set a role | `POST /admin/set-role` (`user.role`) | Omit | The application takes it over; there is no `user.role`. |
| I63 Set a password | `POST /admin/set-user-password` | Omit | The application takes it over, over the server method from A36. |
| I64 Ban / unban | `/admin/ban-user`, `/admin/unban-user` with a reason and an expiry | Omit | The application takes it over. Velve Auth offers `disabled_at` — the session resolution checks it in the same query — as well as the revocation of all sessions; reason and expiry date are application data. |
| I65 Ban enforcement | DB hook `session.create.before`, expired bans lifted lazily (`admin/admin.ts:88-121`) | Omit | Nobody. `disabled_at` is read at every session resolution (section 3.5) — a lock takes effect immediately on existing sessions, not only at the next creation. |
| I66 Manage a user's sessions | `/admin/list-user-sessions`, `/admin/revoke-user-session(s)` | Omit | The application takes it over, over the server methods to B17–B20 with a `user_id`. |
| I67 Hide impersonation sessions | An `after` hook filters them out of `/list-sessions` (`admin/admin.ts:128-144`) | Omit | Removed with B41; there are no sessions that would have to be hidden from the user. |
| I68 Check a permission | `POST /admin/has-permission` | Omit | Like I54; the same check under a different namespace. |
| I69 Admin statements | A statement set of its own including `impersonate-admins` (`admin/access/statement.ts`) | Omit | Like I1. That `impersonate-admins` is a statement shows: impersonation (B41) is a permission problem, not a session problem. |

#### I.4 SSO and SCIM (2)

| Feature | Better Auth | Velve Auth | Reasoning |
|---|---|---|---|
| I70 SSO per domain/organisation | OIDC and SAML2 providers per domain or organisation, 14 endpoints, domain verification, provisioning (`packages/sso/src/`) | Omit | The application or a dedicated product takes it over. No SAML, no SSO (section 3.14). GHSA-5rr4-8452-hf4v (CVSS 9.6, SSRF), GHSA-gv74-j8m3-fg5f, GHSA-prpr-5gj3-qqhg and GHSA-8c5h-wx78-2cfg fall to this package — a capability whose implementation is a security discipline of its own. |
| I71 SCIM 2.0 provisioning | Users and groups by SCIM, group→role mapping, 7–9 tables (`packages/scim/src/`) | Omit | Like I70. No SCIM (section 3.14). Affected by GHSA-rjg6-39jm-rgg4 (CVSS 9.9, ATO over a provider ID collision) and GHSA-j8v8-g9cx-5qf4. |

**I: Adopt 0 · Solve differently 0 · Omit 71 · Surpass 0**

---

### J. Acting as an identity provider (62)

This section too is dropped entirely. Velve Auth is a relying party, not an authorisation server:
no OAuth server of its own, no SAML, no subscription module (section 3.14). The role of the issuer has a
different threat situation than the role of the verifier, and to put them into the same library means
delivering both attack surfaces to every user.

#### J.1 OAuth 2.1/OIDC provider (37)

| Feature | Better Auth | Velve Auth | Reasoning |
|---|---|---|---|
| J1 Authorization endpoint | `GET/POST /oauth2/authorize` (`packages/oauth-provider/src/authorize.ts`) | Omit | Nobody. Whoever wants to be an identity provider operates one — Velve Auth is the sign-in of an application, not the issuing office for foreign ones. The role of the issuer brings client management, token life cycles, consent, claims and metadata with it; none of these capabilities is usable without the others, and almost every one has an entry in the advisory history (J2, J6, J12, J13, J23, J35). That is why the block is dropped as a whole, and the rows that refer to J1 are its components. |
| J2 Token endpoint | `POST /oauth2/token` (`token.ts`) | Omit | Like J1. Exactly here lay CVE-2026-53518 (simultaneous code redemption) and CVE-2026-53517 (refresh rotation forks the token family); the refresh replay without client authentication, CVE-2026-53512, hit the predecessor plugin `oidcProvider`. |
| J3 Introspection | `POST /oauth2/introspect` (RFC 7662) | Omit | Like J1; introspection answers questions about issued tokens that do not exist. |
| J4 Revocation | `POST /oauth2/revoke` (RFC 7009) | Omit | Like J1; what is revoked in Velve Auth is a session (B18–B20), not an issued token. |
| J5 UserInfo | `GET/POST /oauth2/userinfo` | Omit | Like J1; the claims output to foreign clients presupposes a claims model (J28). |
| J6 Dynamic client registration | `POST /oauth2/register` (RFC 7591) | Omit | Like J1. An unauthenticated registration of foreign clients was the way to GHSA-86j7-9j95-vpqj (`javascript:` as `redirect_uri`). |
| J7 Process consent | `POST /oauth2/consent` | Omit | Like J1; a consent interface is a product, not a library. |
| J8 Continue a flow | `POST /oauth2/continue` | Omit | Like J1; a resumable flow is state of the authorisation server. |
| J9 RP-initiated logout | `/oauth2/end-session(/confirm)` (`logout.ts`) | Omit | Like J1; the opposite direction — signing out at the foreign provider — is A20. |
| J10 Back-channel logout | Logout tokens to registered URIs (`logout.ts:259-310`) | Omit | Like J1; back-channel logout sends tokens to registered URIs and is thereby an SSRF surface (cf. J62). |
| J11 AS metadata | `/.well-known/oauth-authorization-server` (RFC 8414) | Omit | Like J1; metadata describes a server that does not exist. |
| J12 OIDC discovery | `/.well-known/openid-configuration` | Omit | Like J1. Better Auth's document at times advertised `alg=none` (GHSA-9h47-pqcx-hjr4). |
| J13 Create a client | `/oauth2/create-client`, `/admin/oauth2/create-client` | Omit | Like J1; CVE-2026-41427 concerned exactly this path. |
| J14 Read a client | `/oauth2/get-client(s)` | Omit | Like J1; client records do not exist (J13). |
| J15 Update a client | `/oauth2/update-client` | Omit | Like J1; see J14. |
| J16 Delete a client | `/oauth2/delete-client` | Omit | Like J1; see J14. |
| J17 Rotate a client secret | `POST /oauth2/client/rotate-secret` | Omit | Like J1. Client secrets are an issuer's duty; on the verifier side Velve Auth manages only its own purpose keys (section 3.8). |
| J18 Public client info | `/oauth2/public-client(-prelogin)` | Omit | Like J1; a display statement about clients that do not exist. |
| J19 Read consents | `/oauth2/get-consent(s)` | Omit | Like J1; consents are state of the issuer (J7). |
| J20 Update/delete a consent | `/oauth2/update-consent`, `/delete-consent` | Omit | Like J1; see J19. |
| J21 Manage protected resources | `/admin/oauth2/resources` CRUD | Omit | Like J1; protected resources are objects of an authorisation server. |
| J22 Link client↔resource | `/admin/oauth2/resources/:id/clients/:client_id` | Omit | Like J1; see J21. |
| J23 Resource indicators (RFC 8707) | Tokens bound to a target resource (`resources.ts`) | Omit | Like J1; GHSA-p2fr-6hmx-4528 shows how hard this binding is to draw completely. |
| J24 DPoP | Sender-constrained access tokens (RFC 9449) (`dpop.ts`) | Omit | Like J1. DPoP binds issued tokens to a key; Velve Auth's session token is bound to nothing but the `__Host-` cookie and the database row, and that on purpose (section 3.5). |
| J25 PKCE configuration | Enforce it or make it optional (`authorize.ts`) | Omit | Like J1. On the client side PKCE is not configurable in Velve Auth but obligatory (C51). |
| J26 Client authentication by JWKS | `private_key_jwt` / client assertions (`client-jwks.ts`) | Omit | Like J1; client authentication presupposes clients (J13). |
| J27 Pairwise subject identifiers | `subjectType` per client (`schema.ts:34-37`) | Omit | Like J1; pairwise subjects are an issuer property — on the verifier side `subject` is always the provider's value (C62). |
| J28 Claims authority | Steers which claims get where (`claims.ts`) | Omit | Like J1. A claims model describes what an issuer hands out; Velve Auth hands nothing out and stores the providers' claims raw (C63). |
| J29 Standard claims | OIDC standard claim mapping (`standard-claims.ts`) | Omit | Like J1; see J28. |
| J30 Claims request parameter | The `claims` parameter is evaluated (`claims-request.ts`) | Omit | Like J1; see J28. |
| J31 Authentication context (`acr`/`amr`) | Is emitted, but supports only `acr = "0"` (`authentication-context.ts:10`) | Omit | Nobody as a protocol feature. The substantive statement — with what the authentication was done — is available in Velve Auth as `session.factors` (section 3.5) and is thereby usable for the application without serving a protocol that Better Auth answers only with `acr = "0"` anyway. |
| J32 Signed query | A signed authorize query for resumption (`signed-query.ts`) | Omit | Like J1; Velve Auth knows resumption state only as a `velve.oauth_flow` row for its own provider sign-in (C52). |
| J33 Provider extensions | Hook one's own extensions into the flow (`extensions.ts`) | Omit | Like J1; extensions of a flow that does not exist. |
| J34 Organisation binding | Bind clients to organisations | Omit | Like J1; presupposes organisations in addition (I6). |
| J35 Refresh token adjustment | Rotation/lifetime configurable (`token.ts`) | Omit | Like J1; CVE-2026-53517 (token family fork) concerned exactly this rotation. |
| J36 Own storage and rate limit configuration | Storage and limits separately adjustable | Omit | Like J1; the core's rate limiting applies to all routes alike (section 3.9), and a second store would be B32. |
| J37 Seven tables of its own | `oauthClient`, `oauthResource`, `oauthClientResource`, `oauthRefreshToken`, `oauthAccessToken`, `oauthConsent`, `oauthClientAssertion` (`schema.ts`) | Omit | Like J1. Seven tables for a role that the library does not play; Velve Auth's schema has sixteen, all for the question "who is signed in" (section 3.17). |

#### J.2 Device authorization (7)

| Feature | Better Auth | Velve Auth | Reasoning |
|---|---|---|---|
| J38 Request a device code | `POST /device/code` (RFC 8628) | Omit | Nobody in the core; a plugin can build it under `/x/…`. The flow presupposes that Velve Auth issues tokens for foreign devices (J1). |
| J39 Poll for the token | `POST /device/token` with `pollingInterval` | Omit | Like J38; the polling is the client side of a grant that does not exist. |
| J40 Verification page | `GET /device` with a rate limit of its own (`device-authorization/index.ts:274-281`) | Omit | Like J38; the library renders no HTML anyway (A52). |
| J41 Approve | `POST /device/approve` | Omit | Like J38. CVE-2026-45337: every authenticated session counted as the owner of every open device code. |
| J42 Deny | `POST /device/deny` | Omit | Like J38; the counterpart to J41, with the same ownership question. |
| J43 `validateClient` callback | A client check of one's own (`routes.ts:370-380`) | Omit | Like J38; a client check presupposes clients (J13). |
| J44 Table `deviceCode` | Two unique indexes, configurable code generation (`schema.ts`) | Omit | Like J38; if a plugin builds the flow, the table belongs to it — with a prefix per section 3.11. |

#### J.3 JWT and JWKS (8)

| Feature | Better Auth | Velve Auth | Reasoning |
|---|---|---|---|
| J45 JWKS endpoint | `GET /jwks` (`plugins/jwt/index.ts:58-68`) | Omit | The application takes it over. Whoever issues tokens to downstream services thereby operates an issuer — with key management, rotation and a grace period as a responsibility of its own. |
| J46 Issue a token | `GET /token` delivers a JWT for the current session (`jwt/index.ts:250`) | Omit | The application takes it over: it has the resolved session and can sign out of it what its services expect. A JWT out of the auth library is a second notion of session that is not revocable. |
| J47 `signJWT` / `verifyJWT` | serverOnly endpoints for one's own JWTs (`jwt/index.ts:286`) | Omit | The application takes it over, with `jose`. A general signing function does not belong in an auth library. |
| J48 Key management | Table `jwks` with `publicKey`, `privateKey`, `alg` (`jwt/adapter.ts`) | Omit | Removed with J45. Velve Auth manages keys only for its own purposes, by HKDF out of one root key (section 3.8). |
| J49 Private key encryption | Private keys symmetrically encrypted, switchable off (`jwt/utils.ts:80-90`) | Omit | Removed with J48. That it is switchable off is a reason of its own. |
| J50 Algorithm choice | Default EdDSA, others choosable (`jwt/adapter.ts:89`) | Omit | Removed with J48. An algorithm choice is an allowlist that somebody has to maintain; `alg=none` (GHSA-9h47-pqcx-hjr4) is the reminder of that. |
| J51 Key rotation with a grace period | Warns on too short an overlap (`jwt/index.ts:92-97`) | Omit | Removed with J48. The rotation of its own keys is solved by Velve Auth over the version ring (H36). |
| J52 JWT cookie cache signer | Signs the session cookie cache with JWKS keys (`jwt/index.ts:79-105`) | Omit | Removed with B23; there is no cookie cache. |

#### J.4 API keys (7)

| Feature | Better Auth | Velve Auth | Reasoning |
|---|---|---|---|
| J53 Create a key | `POST /api-key/create` (`packages/api-key/src/routes/create-api-key.ts:130`) | Omit | The application takes it over. An API key is a machine identity with a lifetime of its own and permissions of its own — not the answer to "who is signed in". |
| J54 Read / list keys | `POST /api-key/get`, `/list` | Omit | Like J53; reading and listing of objects of the application. |
| J55 Update / delete a key | `POST /api-key/update`, `/delete` | Omit | Like J53; expiry and revocation belong to the life cycle of the machine identity, which the application determines. |
| J56 Verify a key | `verifyApiKey`, serverOnly without a path (`routes/verify-api-key.ts:514`) | Omit | Like J53. The check is a hash lookup in an application table; what is missing is the pseudo session (J58), and it is supposed to be missing. |
| J57 Clear up expired keys | `deleteAllExpiredApiKeys` (`routes/delete-all-expired-api-keys.ts:12`) | Omit | Like J53; the clearing up of expired keys is a maintenance run of the application, analogous to `auth.maintenance.sweep()` (L-11). |
| J58 Pseudo session out of an API key | A `before` hook fabricates a session and sets `ctx.context.session` (`api-key/src/index.ts:169-269`) | Omit | Nobody — expressly. An invented session whose token is the plaintext key (`:245`) undercuts every statement of the session model. A plugin may not replace the session resolution (section 3.11). |
| J59 Key properties | Hashing (switchable off), expiry, rate limit, refill, permissions, metadata (`api-key/src/schema.ts`) | Omit | Like J53. That the hashing is switchable off (`disableKeyHashing`) is additionally irreconcilable with the storage rule from section 3.2. |

#### J.5 MCP and CIMD (3)

| Feature | Better Auth | Velve Auth | Reasoning |
|---|---|---|---|
| J60 MCP resource server | Decorates `oauthProvider()`, adds RFC 9728 and RFC 8707 (`packages/mcp/src/plugin.ts:170-224`) | Omit | Nobody; presupposes the authorisation server (J1) and is expressly excluded (section 3.14). |
| J61 `requireMcpAuth` / `createMcpProtectedRequestHandler` | Protection helpers for MCP handlers (`packages/mcp/src/`) | Omit | The application takes it over: `auth.session.resolve(token)` is the building block that such a helper consists of. |
| J62 Client ID metadata document (CIMD) | Resolves OAuth clients out of HTTPS metadata (`packages/cimd/src/`) | Omit | Nobody; presupposes J1. A fetch governor for foreign metadata URLs is moreover an SSRF surface in the auth path. |

**J: Adopt 0 · Solve differently 0 · Omit 62 · Surpass 0**

---

### K. Framework integrations (26)

A uniform block, therefore grouped — every group as a row of its own with its individual items.

| Feature | Better Auth | Velve Auth | Reasoning |
|---|---|---|---|
| K1–K8, K10, K11, K13–K15, K17–K21 — 18 server integrations | Next.js (handler + `nextCookies`), Node (`toNodeHandler`), SvelteKit, SolidStart, TanStack Start (React), TanStack Start (Solid), Astro, Convex, Elysia, Encore, Express, Fastify, Hono, NestJS, Nitro, Nuxt, React Router, Waku — partly modules of their own in `src/integrations/`, partly pure documentation pages | Solve differently | A single output point: `toWebHandler(auth): (Request) => Promise<Response>` from `@velve/auth/http` (section 3.1). Every framework that speaks the Fetch API mounts it unchanged; for `node:http` the application writes the usual request/response adapter or uses an existing one. Framework-specific modules age with the framework, not with the library — and the `nextCookies` special handling exists only because cookies are set outside the response there. |
| K9 Electron | A package of its own with `/electron/token`, `/electron/init-oauth-proxy`, `/electron/transfer-user`, a preload bridge and an extended `transfer_token` cookie (`packages/electron/src/`) | Omit | The application takes it over: sign-in in the system browser per RFC 8252 with a redirect handler of its own, after that `auth.session.resolve(token)`. A handover mechanism with a cookie of its own, extended at every request, is a second notion of session alongside the session cookie. |
| K12 Expo / React Native | A package of its own: `exp://` origins in `init`, an **origin header override**, deep link transfer with `set-cookie` as a query parameter (`packages/expo/src/index.ts:26-102`) | Omit | The application takes it over, likewise over RFC 8252. Both load-bearing mechanisms of the package are irreconcilable with the design: a plugin may neither extend `origins` (G28) nor lift the origin check (section 3.11), and a session token does not belong in a query parameter. |
| K16, K22–K26 — 6 client packages | The Lynx entrypoint, `better-auth/react`, `/vue`, `/svelte`, `/solid` as well as the vanilla client as a runtime proxy over path segments (`client/vanilla.ts:79-110`) | Solve differently | One client from `@velve/auth/client`, generated out of the same route declaration as the handler and the server method — framework-independent, without state management and without a runtime proxy (G33/G36). The five framework clients in Better Auth differ essentially in their reactivity layer; the application already has that layer. |

**K: Adopt 0 · Solve differently 24 · Omit 2 · Surpass 0**

---

### L. Commercial add-ons — "Better Auth Infrastructure" (21)

All over `@better-auth/infra`, not in the repository, expressly "a paid service"
(`docs/content/docs/infrastructure/introduction.mdx`). Velve Auth has no commercial layer:
what it can do, it can do in the library; what it cannot do, it says.

| Feature | Better Auth | Velve Auth | Reasoning |
|---|---|---|---|
| L1 `dash()` plugin | Connects the instance with the hosted dashboard | Omit | Nobody. No admin interface (section 3.14), and certainly none that binds the instance to a foreign service. |
| L2 User management in the dashboard | View, search, ban, delete | Omit | The application takes it over; it has direct database access (I61). |
| L3 Session monitoring | See and revoke active sessions | Omit | The application takes it over, over B17–B20 as server methods. |
| L4 Organisation overview | Manage organisations and members | Omit | Removed with I6; an interface over objects that do not exist. |
| L5 Analytics | Sign-ups, sign-ins, active users over time | Omit | The application takes it over. `velve.user.created_at` and `velve.session.created_at` are ordinary columns in its database. |
| L6 Activity tracking | Maintains `user.lastActiveAt` with a configurable interval | Omit | Present in a different shape: `session.last_used_at` is carried anyway (written at most hourly). A second column on the user row is not needed. |
| L7 Managed directory sync | Managed SCIM connection over the control plane | Omit | Removed with I71; a managed service around a capability that does not exist. |
| L8 Audit logs | Collect and query an event history | Omit | The application takes it over. No audit log (section 3.14): a log that the library writes into the same database is exactly as trustworthy as the process that writes it. What the library delivers are events at the `logger` and the enumerated `after` points. |
| L9 Audit events: user | 7 events (`user_signed_up`, `user_banned`, …) | Omit | Like L8; `afterUserCreate` covers the part that the library knows at all. |
| L10 Audit events: session | 7 events (`user_signed_in`, `session_revoked`, …) | Omit | Like L8; `afterSignIn`, `afterSessionCreate`, `beforeSessionRevoke` are the hook-in points. |
| L11 Audit events: account | 3 events (`account_linked`, `account_unlinked`, `password_changed`) | Omit | Like L8. For linkings there is no hook (F41); the application logs around its call of `identity.link`/`identity.unlink`, with the result that it receives anyway. |
| L12 Audit events: verification | 3 events (`password_reset_requested/completed`, …) | Omit | Like L8; the reset request and its completion are calls of the application, whose result it can log itself. |
| L13 Audit events: organization | 14 events | Omit | Removed with I6; fourteen events over objects that do not exist. |
| L14 Audit events: security | 11 events out of Sentinel | Omit | Removed with L15; the events are outputs of a detector that is not present. What the library reports instead is the alarm callback per route from section 3.9. |
| L15 `sentinel()` plugin | A defence layer with `log`, `challenge`, `block` | Omit | The application or a specialised service takes it over. A behavioural defence needs data across many tenants; a library in the user's process does not have it. Velve Auth delivers instead the three counters from section 3.9, among them the alarm callback per route. |
| L16 Credential stuffing protection | Thresholds for challenge/block, time windows, cooldown | Omit | Like L15; the account bucket from section 3.9 is the part that the library can honestly provide — without a lock and without a delay (L-5). |
| L17 Impossible travel, geo-blocking, bot blocking, suspicious IP | Four independent detectors | Omit | Like L15; all four need data sources (a geo database, reputation lists) that a library is not supposed to bring along. |
| L18 Velocity limits and free-trial abuse | Rate-based and abuse-related detection | Omit | Like L15; abuse detection over trial phases presupposes a subscription model (M1). |
| L19 Compromised password and stale account detection | Compromised passwords, long-inactive accounts | Omit | The application takes it over (A49); it recognises inactive accounts by `session.last_used_at` and `user.created_at`. |
| L20 Email validation/normalisation, proof of work, unknown device notification | Further Sentinel building blocks | Omit | Partly present in the core anyway: the email normalisation is a core component and secured by a CHECK constraint (E4). The rest belongs to the application. |
| L21 Managed email and SMS | A dispatch service with 13 email and 3 SMS templates | Omit | The application takes it over. No built-in dispatch, only the `email.send` callback (section 3.15, A.7) — and therefore also no templates that go to the application's users in the language and the tone of a foreign provider. |

**L: Adopt 0 · Solve differently 0 · Omit 21 · Surpass 0**

---

### M. Payment/subscription plugins (9)

| Feature | Better Auth | Velve Auth | Reasoning |
|---|---|---|---|
| M1 Stripe | Subscriptions, customers, seats, webhooks; `/stripe/webhook`, `/subscription/*` (`packages/stripe/src/`) | Omit | The application takes it over. No subscription/payment module (section 3.14). Billing shares with authentication only the foreign key on `user`. |
| M2 Stripe schema | Table `subscription` + `user.stripeCustomerId` (`stripe/src/schema.ts`) | Omit | Like M1; `user.stripeCustomerId` is additionally exactly the foreign column on a core table that is not supposed to exist (E5). |
| M3 Stripe↔organization coupling | Overrides in `init` the `organizationHooks` of another plugin (`stripe/src/index.ts:186-256`) | Omit | Nobody — expressly. A plugin may neither read nor write the options of other plugins (section 3.11); this coupling is the proof of where an open `init` leads. |
| M4 Polar | Checkout, portal, usage, webhooks (`@polar-sh/better-auth`) | Omit | The application takes it over; like M1. |
| M5 Autumn | Pricing plans, usage metering, feature permissions (`autumn-js`) | Omit | The application takes it over; "Feature-Permissions" are moreover a permission model (I1). |
| M6 Creem | Subscriptions and payments (`@creem_io/better-auth`) | Omit | Like M4; a further payment provider, the same dividing line. |
| M7 Chargebee | Subscriptions and payments (`@chargebee/better-auth`) | Omit | Like M4; the integration belongs to the provider that maintains it, not to the sign-in library. |
| M8 Dodo Payments | Subscriptions and payments (`@dodopayments/better-auth`) | Omit | Like M4. The foreign packages hang on Better Auth's plugin interface; for Velve Auth they would have to be rewritten anyway, under `/x/…` and with tables of their own. |
| M9 Commet | Billing and usage (`@commet/better-auth`) | Omit | Like M4; usage billing needs events of the application, not of the sign-in. |

**M: Adopt 0 · Solve differently 0 · Omit 9 · Surpass 0**

---

### 1.N What Velve Auth can do and Better Auth cannot

Capabilities without a counterpart in Better Auth v1.7.3. Every row names the source reference at which the
absence is evidenced — source code, advisory or issue.

| Capability | Why it does not exist in Better Auth | What Velve Auth does |
|---|---|---|
| Multi-algorithm verification path | There is exactly one `hash` and one `verify` function; a verifier chain is not provided for; `grep -rn "hash.startsWith"` delivers a single hit across `packages/`, and it concerns a URL fragment (`electron/src/browser.ts:132`) (inventory N1-2) | A switch on the PHC prefix over six families: `$argon2id$`, `$argon2i$/$argon2d$`, `$2a$/$2b$/$2y$/$2x$`, `$scrypt$`, `$pbkdf2-sha256$/-sha512$`, `$fbscrypt$`. Only Argon2id is created, everything is verified (section 3.3). |
| Silent rehash at sign-in | `grep -rn "rehash\|needsRehash\|upgradeHash" packages/` delivers zero hits; `signInEmail` writes nothing back on success (`api/routes/sign-in.ts:557-560`) | After a successful check, `needsRehash` is determined and, after the sending of the response, written in a bounded background task by compare-and-swap (`WHERE user_id = $1 AND phc = $alt`). If it fails, nothing is broken. Without user interaction. |
| `verify` gets context and a return channel | The signature is `verify({hash, password})` — no user, no `ctx`, no "please rehash" (inventory N1-5) | The verification path delivers a result **and** the need for a rehash; it is a core component and not replaceable, which is why the return channel can exist. |
| Canonical PHC storage format | The format is `salt_hex:hash_hex` without an algorithm, parameter or version identifier (`crypto/password.test.ts:11`); a parameter change devalues all hashes | One PHC string per account, stored encrypted (L-2), plus the plaintext column `scheme` for evaluations without decryption. A PHC parser of one's own of ~40 lines, no dependency (section 2.7). |
| Argon2id at all | Not implemented; feature request #6608 "closed as not planned" | Argon2id as the standard with m = 19456 KiB, t = 2, p = 1, 32 bytes of output, 16 bytes of salt (OWASP minimum recommendation), configurable upwards. |
| A semaphore over the simultaneous KDF calls | No concurrency protection in the password path; scrypt with N=16384, r=16 likewise occupies memory | The core holds a semaphore over the KDF calls (default `min(4, cpus)`). Those waiting run into a waiting limit of 5 s and are then refused, instead of running into a memory error (section 3.3, L-1). |
| Length check before the KDF | `/sign-in/email` passes an arbitrarily long password directly into scrypt (`api/routes/sign-in.ts:521-560`, inventory N1-9) | Empty and over 4096 bytes are refused **before** a KDF is called — on all four paths (registration, sign-in, reset, change). |
| Three identity configurations without an email requirement | `user.email` is `NOT NULL UNIQUE` (`core/src/db/get-tables.ts:208-216`); the documentation says so expressly (`docs/…/concepts/oauth.mdx:409`), Issue #9124 is open | `email`, `username`, `username_email` — chosen at initialisation, materialised as a CHECK constraint in the migration. No invented addresses; `createPlaceholderEmail` has no counterpart (section 3.4 and 3.10). |
| A start error instead of a silent lockout | A configuration without email does not exist (E2), so there is also no case in which the absence of a way back would have to be enforced; the username plugin hangs a column onto a model that presupposes the email (`plugins/username/schema.ts:6-58`) | `identity: "username"` without `recoveryCodes` is a start error — and over `RecoveryCodesRequirement` already a compile error (section 3.15, A.3): without email there is no reset, and that is enforced instead of documented. |
| Firebase migration | In the whole of `docs/content/docs/guides/` there is no Firebase guide; present are only Supabase, Clerk, Auth0, Auth.js/NextAuth, WorkOS (inventory N4-35) | A `$fbscrypt$` verifier (scrypt + AES-256-CTR) in the same format that GoTrue uses — with it, Firebase **and** Supabase stocks can be adopted unchanged. `imported_from`/`imported_at` hold the origin fast. |
| Import without a foreign raw format | Better Auth stores its own raw format and can check foreign ones only over a replaced verifier (A10) | The import normalises every source format into a PHC string; e.g. Better Auth's `salt_hex:hash_hex` becomes `$scrypt$ln=14,r=16,p=1$<salt_b64>$<hash_b64>`. A foreign raw format is never stored. |
| Session tokens stored only hashed | Tokens lie in plaintext in the database, without a hashing option (`db/internal-adapter.ts:513`, inventory N3-19) | What is stored is exclusively `sha256(token)` with a `UNIQUE` constraint; the plaintext token leaves the process only in the cookie. |
| The `__Host-` cookie prefix | The constant exists but is never set (`cookies/cookie-utils.ts:34-35`; `createCookieGetter` sets only `__Secure-`, inventory N3-22) | `__Host-velve_session` and `__Host-velve_pending`: `Secure` enforced, `Domain` forbidden, `Path=/`. Cookie tossing from a subdomain is structurally excluded. |
| Password reset revokes sessions by default | `revokeSessionsOnPasswordReset` is **off** by default (`api/routes/password.ts:328-330`); the same at `/change-password` (inventory N3-20) | Reset and change revoke all other sessions. No switch (section 3.5). |
| A second lifetime (an absolute expiry date) | There is exactly one `expiresAt`, which is extended without bound by a sliding window (`create-context.ts:313`, `session.ts:324-412`) | `idle_expires_at` (extendable, written at most hourly) and `absolute_expires_at` (never extended). Both stand in the predicate of the resolution. |
| The intermediate state for 2FA as an artefact of its own | The state is a generic verification record plus a signed cookie in the plugin (`two-factor/index.ts:533-563`); the cookie cache could make it into a session (GHSA-xg6x-h9c9-2m83, CVSS 9.1) | `velve.pending_authentication` with `factors_completed` and `attempts`, a cookie of its own with a 5 minute runtime, accepted by exactly four routes; every other one ignores it completely (section 3.6). |
| `factors` on the session | There is no field that holds fast with what the authentication was done; its own OIDC provider emits only `acr_values_supported: ["0"]` (`oauth-provider/src/metadata.ts:181`, inventory N3-34) | `session.factors text[]` with `password`, `totp`, `webauthn`, `recovery`, `oauth`. Not a permission but part of the answer to "who is signed in, and how securely". |
| Passkey distinction device-bound / synchronised | `deviceType`/`backedUp` are indeed stored, but `requireUserVerification: false` at both verification places makes passkeys no factor there anyway (`packages/passkey/src/routes.ts:658,909`, inventory N3-33) | `backup_eligible` and `backup_state` are stored separately out of the authenticator data and updated at every sign-in; `userVerification: "required"`. The application can base a policy on that, the library enforces none. |
| Passkey as a sign-in method of its own with `factors` | A passkey login circumvents enforced 2FA, because the 2FA `after` hook matches only `/sign-in/email\|username\|phone-number` (`two-factor/index.ts:434-439`, inventory N3-32) | A passkey sign-in yields `factors = {webauthn}` without a password; as a second factor it yields `{password, webauthn}`. Both in the core, which is why there is no path that runs past a hook. |
| Versioned, transactional migrations | No migration history, no `_migrations` table, no `down`; not transactional; only for Kysely (inventory N4-37/39/40) | `velve.schema_migration` with version, name, point in time and checksum; every step in a transaction of its own; plugin migrations in the same runner; a version deviation at the start is an error. |
| `ON CONFLICT` rate limiting in one round trip | No upsert in the adapter API; the rate limiter emulates it with up to four round trips (`api/rate-limiter/index.ts:148-166`, inventory N4-42) | One `INSERT … ON CONFLICT DO UPDATE SET tokens = LEAST(...) - 1 … RETURNING tokens`. Negative means refused (section 3.9). |
| IPv6 /64 normalisation | The key was the textual IP without normalisation; a client with a `/64` could generate 2^64 buckets (GHSA-p6v2-xcpg-h6xw / CVE-2026-45364) | Normalisation to `/32` (v4) or `/64` (v6) before the key is formed; `X-Forwarded-For` only with configured `trustedProxies`. |
| Rate limiting per account | The key is `ip\|path`, there is no counter per account; lockouts exist only in the 2FA plugin (`core/src/utils/ip.ts:395-399`, inventory N3-28) | Three counters at once: the IP prefix, the account as a bucket with a slowly refilling rate (exceedance is a refusal, not a lock and not a delay, L-5), and globally per route as an alarm callback. |
| The bucket key over the resolved route name | The router collapses empty segments, `//sign-in/email` runs past path limits (GHSA-x732-6j76-qmhm, CVSS 8.6) | The key contains the resolved route name, not the raw path. |
| A Postgres schema of its own | All tables lie in the application's search path; that is why `modelName`, `fields` and `usePlural` exist, to dodge collisions | Everything lies in `velve` (configurable). Nothing collides, `user` needs no quotation-mark discipline, and the naming options fall away without replacement (section 3.2). |
| Real PostgreSQL types and constraints | No partial indexes, no expression indexes, no PG enums, no `inet`, no CHECK constraints, no triggers; `string[]` lands as a JSON string in `jsonb` (inventory N4-45/46/47) | `uuid`, `timestamptz`, `bytea`, `inet`, `text[]`, `jsonb`, partial unique indexes, CHECK constraints for the normalisation and the identity rule, a trigger against `UPDATE session SET user_id`. |
| Uniqueness of `(provider, subject)` in the database | No unique constraint on `account(providerId, accountId)`; the check stands in JavaScript and is susceptible to races (`db/internal-adapter.ts:1192-1215`, inventory N4-43) | `CONSTRAINT identity_provider_subject UNIQUE (provider, subject)`. The email is never a linking key. |
| Linking conditions that cannot be switched off | The auto-link gate never read the local `emailVerified` (CVE-2026-53516, CVSS 8.3); the magic link/OTP variant is GHSA-qq9h-g4jm-xgf3 | Automatic linking happens only when the provider reports the email as verified **and** the local account is verified **and** the provider stands in `trustedProviders`. All three, without exception (section 3.10). |
| Enumerated plugin extension points with a start error on collision | Collisions of endpoints and tables are only logged (`api/index.ts:153-170`); there is no sandboxing, no declared dependencies and no topological sorting (inventory N5-54/55/56) | Seven enumerated hook points, the namespace `/x/<plugin-id>/…`, the table prefix `<plugin-id>_`, `dependsOn` with topological sorting, a frozen context — and a name conflict is a start error. |
| Purpose-separated keys with rotation | The same secret signs cookies, signs email JWTs and HMACs the cookie cache; HKDF only in the JWE path; for signing keys there is no rotation (inventory N3-26/27) | One root key, out of it by HKDF-SHA256 `cookie-sig`, `token-pepper`, `totp-enc`, `oauth-token-enc`, `pkce-enc`, `password-enc`; every value carries its version, a ring permits rotation without an outage — and because sessions are database rows, every rotation survives all sessions (section 3.8). |
| Recovery codes as HMAC instead of encrypted | Backup codes are stored encrypted by default so that `viewBackupCodes` can display them (`backup-codes/index.ts:44-55,552-590`) | `HMAC-SHA256(pepper, code)` with `(user_id, code_hmac)` as the primary key: the lookup is one index hit, consumption is `DELETE … RETURNING`, and displaying is impossible. |
| TOTP replay protection over the primary key | No protection against the reuse of the same time step documented in the 2FA plugin | `velve.totp_used_step` with the primary key `(user_id, time_step)`: an `INSERT` that fails on conflict **is** the check. |
| Byte-for-byte identical responses as the default | The enumeration protection is not the default; in the standard setup `/sign-up/email` answers with `422 USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` (`api/routes/sign-up.ts:329-332`, inventory N3-30) | Sign-in, registration, password reset and email change deliver byte-for-byte identical responses for existing and non-existing accounts — the same status, the same headers, the same body. The difference moves into the email (section 3.13). |
| A message to the existing address on an attempted registration | Better Auth invents a synthetic user object instead (`sign-up.ts:236-305`) | To the existing address goes "somebody has tried to register with your address" with a sign-in link instead of a confirmation link. |
| One route declaration instead of a runtime proxy | The client is a proxy that sends off every path; without `pathMethods` the heuristic "body present → POST" applies (`client/proxy.ts:12-34,36-125`, inventory N7-77/78) | Path, method, input schema, output type and error codes are declared **once**; out of that the server handler, the server method and the client come into being. A client call that does not exist does not compile (section 3.12). |
| Security middleware on direct server calls too | `onRequest`/`onResponse`/`middlewares` do not run at `auth.api.*`; captcha and the SCIM content-type check are ineffective there (`api/to-auth-endpoints.ts:88-116`, inventory N3-31) | The origin check and the rate limiting always lie before the route logic — on direct server calls too (section 3.11). There is exactly one interception model. |

Not a capability, but a stance that belongs to the 36 rows: the limits stand in the design and are documented — no reset by email in the configuration `username`, enumerable usernames, key loss as password loss (L-2), bcrypt stocks that until the rehash check only the first 72 bytes. Better Auth presents placeholder addresses as a solution and in `SECURITY.md` guarantees only the respectively latest version.

---

### 2.N The numbers

#### Per section

| Section | Title | Features | Adopt | Solve differently | Omit | Surpass |
|---|---|---:|---:|---:|---:|---:|
| A | Core authentication | 52 | 23 | 14 | 12 | 3 |
| B | Sessions | 46 | 8 | 5 | 32 | 1 |
| C | Social sign-in / OAuth | 96 | 23 | 56 | 13 | 4 |
| D | Second factor and alternative factors | 52 | 20 | 8 | 19 | 5 |
| E | Identity and user model | 27 | 5 | 5 | 14 | 3 |
| F | Database | 58 | 7 | 20 | 28 | 3 |
| G | Extensibility | 41 | 8 | 10 | 19 | 4 |
| H | Operation and cross-cutting concerns | 57 | 17 | 15 | 20 | 5 |
| I | Authorisation and organisations | 71 | 0 | 0 | 71 | 0 |
| J | Acting as an identity provider | 62 | 0 | 0 | 62 | 0 |
| K | Framework integrations | 26 | 0 | 24 | 2 | 0 |
| L | Commercial add-ons | 21 | 0 | 0 | 21 | 0 |
| M | Payment/subscription plugins | 9 | 0 | 0 | 9 | 0 |
| | **Sum** | **618** | **111** | **157** | **322** | **28** |

Shares: Adopt 18.0 % · Solve differently 25.4 % · Omit 52.1 % · Surpass 4.5 %.

**Separate count — plugin decisions (G.2):** 38 packages (26 in the main package, 12 external) —
Adopt 2, Solve differently 7, Omit 29. These rows are decisions about packages; the
features of the plugins themselves are already contained in the 618.

**The opposite direction:** section 1.N counts 36 capabilities that Better Auth does not have. They cover
44 of the 78 gaps evidenced in the inventory; the remaining 34 concern areas that Velve Auth
does not enter in the first place (SAML IdP, LDAP, PAR/CIBA, mTLS, SCIM client, multi-column sort, savepoints).

#### What the distribution says about the product

Somewhat more than half of the features is dropped, and the lion's share of that lies in three blocks: authorisation and organisations (71),
the identity provider role (62) and commercial add-ons plus payment (30). Those are 163 of the 322 omitted features — more than half — and
they do not fall away for reasons of time but because they answer other questions than "who is signed in". If one subtracts them, 159 omissions remain
across the actual authentication sections, and those spread almost entirely over three patterns: security checks that can be switched off
(`disableCSRFCheck`, `skipStateCookieCheck`, `disableKeyHashing`), second truths about the state (cookie cache, secondary storage, stateless
sessions) and configuration surfaces that exist only because a design decision was left open (name mapping, four ID strategies, three
storage strategies per token, eleven adapters).

The second-largest block is "Solve differently" with 157 features — the capability comes, the mechanism does not. The value concentrates in C (56, in
essence the provider list) and F (20, the database layer). That "Solve differently" is almost twice as frequent as "Adopt" is the actual
statement of this evaluation: Velve Auth hardly disputes any capability with Better Auth, but almost always only the way to it. As a rule the
change consists in replacing an option by a behaviour — `revokeSessionsOnPasswordReset` becomes the rule, `requireLocalEmailVerified` becomes the
condition, `pathMethods` becomes the declaration, `encryptOAuthTokens` becomes the default setting "do not store at all".

The 111 adopted features are the proof that Better Auth largely got the cut of the core operations right:
registration, sign-in, verification, reset, email change, account deletion, session management, OAuth mechanics and the atomic consumption primitives
are adopted unchanged. The 28 surpassings are by contrast conspicuously unevenly distributed: they lie almost all where Better Auth had an advisory
— the password path (A7, A9, A34), the session storage (B2), the linking rule (C86), the second-factor intermediate state (D16, D33), the cookie prefix (H19),
the rate limiting (H4, H9) and the key rotation (H36).

Let it also be named deliberately what this distribution costs. Whoever today runs Better Auth with `organization`, `admin`, `sso`, `oauth-provider` or `stripe`
finds no counterpart in Velve Auth and has to build these capabilities in the application or with another product. Whoever uses MySQL, SQLite,
Prisma, Drizzle or MongoDB cannot switch. Whoever needs the cookie cache for latency reasons loses it. That is the price for
every remaining guarantee holding without reservation.

---

## 2. Language and runtime

### 2.1 The recommendation

**Pure TypeScript. No Rust/WASM module of our own. Shipped as precompiled ESM with type declarations.**

`hash-wasm` is supported as an **optional** peer dependency. If it is installed, it takes over Argon2id; if it is not, `@noble/hashes` computes. The hashes are byte-identical, a switch in either direction requires no data migration.

### 2.2 The three designs evaluated

| | A — pure TypeScript | B — TS + our own Rust/WASM | C — TS + third-party WASM on the required path |
|---|---|---|---|
| Argon2id (19 MiB, t=2, p=1) | 263 ms | 47 ms (Rust→WASI) / 76 ms (C→WASM) | 76 ms |
| Runs in Cloudflare Workers | yes | no | no |
| Runs on Caprock | ESTIMATE: yes, without assumptions going beyond web standards (2.6) | untested | untested |
| Build tools | one (tsc/tsdown) | two (+ Rust, wasm-pack, CI target) | one |
| Verifiability of what is shipped | source readable | `.wasm` blob in the npm package | the third party's `.wasm` blob |
| Audit status of the base | Cure53 for `@noble/hashes` (2022, Argon2 excluded) and `@noble/ciphers` (2024, full) | own code, never audited | not audited, last release 11/2024 |
| Bundler behaviour (Next, Vite) | unremarkable | special handling needed | special handling needed |
| Memory after use | drops back | grows and never shrinks | grows and never shrinks |

All measurements: 2 vCPU Xeon @ 2.80 GHz, Node 22.22.2, median of seven runs (three for the most expensive). Cloud containers deliver orders of magnitude, not absolute values; on typical server hardware the factor is the same, the level lower by a factor of 2–4. Complete raw data in `findings/06-krypto-bibliotheken.md`, section 3.6.

On the audit caveat: the Cure53 report on `@noble/hashes` (version 1.0.0, January 2022) explicitly excludes Argon2. The evidence for noble's Argon2id is therefore not the audit but the measurement: `@noble/hashes`, `hash-wasm` (C→WASM) and `@node-rs/argon2-wasm32-wasi` (Rust→WASM) produce byte-identical hashes at the same parameters and verify each other (`findings/06-krypto-bibliotheken.md`, section 1.5 there). Three independent codebases do not make the same mistake.

### 2.3 Why A and not B

The speed advantage is real, but it is paid for in the wrong place.

**The advantage of a Rust module of our own over a ready-made WASM package is a factor of 1.6** (47 ms against 76 ms) — and of all things the fast route there goes through `node:wasi`, `node:worker_threads` and `node:fs`. Those are exactly the modules that are not guaranteed on a thin Linux compatibility layer. The design would therefore introduce two toolchains and an unverifiable binary blob, in order possibly not to start at all in the target environment.

**WASM costs the portability the library exists for.** `hash-wasm` fails in Cloudflare Workers with `Wasm code generation disallowed by embedder`; that is not a configuration question but a property of the platform, which loads only precompiled modules. A self-built module would meet the same thing, because the cause is "compiling WASM from bytes at runtime", not `hash-wasm`. Whoever builds a sign-in library whose stated goal is location independence must not tie its core to a mode of execution that widespread runtimes forbid.

**The zeroize argument speaks against WASM, not for it.** `@noble/hashes` already wipes its intermediate buffers (`clean()` is called eight times in `argon2.js`). The actual problem is the immutable JavaScript strings the password arrives in — WASM has those just the same, because the string exists before the transition. In exchange, `WebAssembly.Memory` grows monotonically: after a 256 MiB hash, 259.5 MB remained allocated externally, even after explicit garbage collection. Pure JavaScript dropped back to 65.5 MB.

**For a very small team the number of toolchains counts for more than just under 200 ms.** A Rust toolchain in CI, a second delivery path, reproducible binary builds and a blob nobody can read up in the package — that is permanent load for a gain that a semaphore and a suitable instance size deliver too.

**Pure JavaScript can do something WASM cannot.** `argon2idAsync({ asyncTick: 10 })` yields to the event loop during the computation: the longest block drops from 317 ms to 12 ms, with the total duration unchanged (317 against 316 ms). The `async` interface of `hash-wasm`, by contrast, is only a promise around a synchronous call and blocks for the full 62 ms. For a server with one thread that is operationally worth more than raw throughput.

**And the switch stays open.** Because the three implementations produce byte-identical output (2.2), the compute engine is an interchangeable component behind an interface. If it turns out in a year that 263 ms is too much, the package is swapped — not the database.

### 2.4 Where non-JavaScript wins anyway

Where it is to be had without native bindings, because it is already in the runtime: **`crypto.subtle`**.

- PBKDF2 with 600,000 iterations: 269 ms via `crypto.subtle`, 926 ms in JavaScript — and 2161 ms via `hash-wasm`, which here is **slower than pure JavaScript**, because it crosses the boundary between JavaScript and WASM once per iteration.
- SHA-2 on large blocks: 3.1 ms against 8.5 ms per MiB. With 32-byte inputs this reverses, there the `await` dominates.
- AES-256-GCM: hardware-accelerated, present in every Web Crypto runtime.

That is the reason the encryption of stored secrets rests on `crypto.subtle` and not on `@noble/ciphers` — the latter is kept as a fallback for runtimes without a complete Web Crypto implementation (E-03). For that, the ciphertext carries an algorithm prefix, so that a later switch does not devalue existing data.

### 2.5 What "no build step at the user" concretely means

- The npm package contains `dist/*.mjs` and `dist/*.d.mts`. No `postinstall`, no `node-gyp`, no `.node` file, no downloader.
- ESM only. CommonJS is not shipped; whoever needs it uses dynamic `import()`.
- `exports` with subpaths, `types` per subpath, checked with `publint` and `attw` in the release gate.
- Dependencies of the core: `@noble/hashes`, `@noble/ciphers`, `bcryptjs`, `otpauth`, `@simplewebauthn/server`, `jose`. Six. `bcryptjs` belongs to the core because the bcrypt check is part of the verification path (section 3.3) and not only of the import: an imported bcrypt hash is checked at every sign-in until the rehash has replaced it. All six are without native bindings and without a `node:` import on the required path (`findings/06`, section 1.1: zero `.node` files, zero install scripts in the entire tree).
- Node from 20.19 (requirement of `@noble/hashes` 2.x; global `crypto`, `crypto.subtle`, `getRandomValues`, `AbortSignal.timeout`). `@simplewebauthn/server` officially guarantees only Node 22; its code contains no Node builtins. ESTIMATE: runs on Node 20, unverified.

### 2.6 Portability to Caprock

The library makes the following assumptions — and no others:

| Assumption | Why it holds |
|---|---|
| `globalThis.crypto` with `subtle` and `getRandomValues` | web standard, not a Node module |
| `fetch` for OAuth providers | web standard |
| a PostgreSQL driver supplied by the caller | the driver is a parameter, not an import |
| no `node:fs`, `node:wasi`, `node:worker_threads`, `node:child_process` | not used on the required path |
| keys come from an interface, not from `process.env` | `KeyProvider`, section 3.8 |

The last point is the one that actually matters. ESTIMATE: on Caprock secrets are passed as a capability, not as an environment variable. Because the core obtains keys exclusively through `KeyProvider`, that is an exchange of the implementation — nothing changes for the caller, and no line in the core knows the difference.

Two conditions on the choice of packages follow from this: `otpauth` is loaded via the `default` or `./slim` export branch, not via the `node` branch (only that one imports `node:crypto`); and if Web Crypto is missing on the compatibility layer, `@noble/ciphers` takes over the encryption (2.4).

**ESTIMATE:** the porting effort to Caprock amounts to one new `KeyProvider` implementation and one driver check, in the order of one to two person-days — provided Node starts there and the chosen PostgreSQL driver copes with the available network abstraction. That precondition is not verified and is the only serious uncertainty.

### 2.7 The cryptographic primitives at a glance

The table assigns each purpose from section 3 its package: the six prefix families of the verification path (3.3), the six key purposes (3.8) and the remaining building blocks.

| Purpose | Package / API |
|---|---|
| Produce + verify Argon2id (`$argon2id$`, `$argon2i$`, `$argon2d$`) | `@noble/hashes/argon2` (`argon2idAsync`, `asyncTick: 10`) |
| Verify bcrypt (`$2a$`, `$2b$`, `$2y$`, `$2x$`) | `bcryptjs` (core; `truncates()` for the 72-byte check on byte length) |
| Verify scrypt (`$scrypt$`) | `@noble/hashes/scrypt` |
| Verify PBKDF2 (`$pbkdf2-sha256$`, `$pbkdf2-sha512$`) | `crypto.subtle.deriveBits`, fallback `@noble/hashes/pbkdf2` |
| Verify Firebase scrypt (`$fbscrypt$`) | `@noble/hashes/scrypt` + `crypto.subtle` AES-256-CTR |
| Parse / serialise PHC | own parser, ~40 lines, no dependency; not `@phc/format` (CJS, without types, `Buffer`) |
| CSPRNG (session tokens, one-time artefacts, salt, nonces) | `crypto.getRandomValues` |
| HKDF-SHA256 — derivation of the six purpose keys `cookie-sig`, `token-pepper`, `totp-enc`, `oauth-token-enc`, `pkce-enc`, `password-enc` | `crypto.subtle.deriveBits` (HKDF) |
| SHA-256 (`token_sha256`, `state_sha256`), HMAC-SHA256 (`cookie-sig`, `token-pepper`: recovery codes, account counters) | `crypto.subtle` for large blocks; `@noble/hashes/sha2`, `/hmac` synchronously for short inputs |
| AES-256-GCM (`totp-enc`, `oauth-token-enc`, `pkce-enc`, `password-enc`) | `crypto.subtle`, fallback `@noble/ciphers` |
| Constant-time comparison | own XOR loop over `Uint8Array` of equal length; `crypto.timingSafeEqual` is Node-specific |
| TOTP (RFC 6238) | `otpauth` (subpath `otpauth/slim`) |
| WebAuthn | `@simplewebauthn/server` (CBOR via the bundled `@levischuck/tiny-cbor`, pure JavaScript) |
| ID token signatures of the OAuth providers (JWS against JWKS) | `jose` |

`hash-wasm` is an **optional** peer dependency as an accelerator. If it is found, it produces and verifies Argon2id; the output is byte-identical with `@noble/hashes`, a switch requires no migration. For bcrypt (10 % gain), PBKDF2 (2.3 times slower) and SHA-2, WASM brings nothing and is not used.

---
## 3. Target architecture

Velve Auth answers exactly one question: **who is signed in**. No roles, no permissions, no organisations, no teams, no profile data. The library runs in the application's process, the data lies in the application's database.

### 3.1 Package structure and module boundaries

One npm package `@velve/auth` with subpath exports. No monorepo, no
cross-package version drift.

```
@velve/auth              core: createVelveAuth(), all core operations
@velve/auth/http         toWebHandler(): (Request) => Promise<Response>
@velve/auth/client       typed client, derived from the same route declaration
@velve/auth/pg           driver for node-postgres
@velve/auth/postgres-js  driver for postgres.js
@velve/auth/neon         driver for @neondatabase/serverless
@velve/auth/import       migration module (heavy dependencies only here)
@velve/auth/schema       generated SQL, migration runner
@velve/auth/testing      test helpers (clock control, deterministic randomness)
```

Internal module boundaries:

```
core/
  identity/     identity configuration, normalisation, uniqueness
  password/     scheme switch, PHC, rehash policy
  session/      creation, resolution, rotation, revocation
  token/        one-time artefacts: creation, atomic consumption
  factor/       TOTP, WebAuthn, recovery codes, intermediate state
  oauth/        authorisation code flow, PKCE, identity linking
  limit/        token bucket
  keys/         KeyProvider, HKDF purpose derivation, key ring
  db/           driver interface, repositories, migration runner
  http/         route declaration, origin check, cookies, error mapping
  plugin/       registry, topological sorting, hook execution
```

### 3.2 Database and schema

Everything lies in a **schema of its own in Postgres**, by default `velve`
(configurable). That way nothing collides with the application's tables. `user`
is a reserved word in SQL; as the schema-qualified name `velve.user` it is
valid without quotation marks, because PostgreSQL permits any keyword after the
dot. Only an unqualified `user` would need quotation marks,
and unqualified names do not occur (E-07).

No query abstraction. All SQL is hand-written for PostgreSQL;
PostgreSQL from version 14 is assumed (`gen_random_uuid()` has been available
without an extension since 13). The driver interface is deliberately small:

```ts
interface Driver {
  query<T>(sql: string, params: unknown[]): Promise<T[]>
  transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T>
}
```

#### The complete schema

This is the initial form. The changes from decisions L-2 and L-3 and
the two tables of the migration module are in 3.17; together the two
blocks make up the schema with sixteen tables.

```sql
CREATE SCHEMA IF NOT EXISTS velve;

-- Identity. Deliberately minimal: no profile data.
CREATE TABLE velve.user (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text,
  email_verified_at timestamptz,
  username          text,            -- display form, as entered (NFKC)
  username_key      text,            -- comparison form: NFKC + casefold
  disabled_at       timestamptz,
  imported_from     text,            -- 'supabase' | 'clerk' | 'auth0' | 'firebase' | 'nextauth'
  imported_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_email_normalized    CHECK (email IS NULL OR email = lower(email)),
  CONSTRAINT user_username_normalized CHECK (username_key IS NULL OR username_key = lower(username_key)),
  CONSTRAINT user_username_pairing    CHECK ((username IS NULL) = (username_key IS NULL))
);
CREATE UNIQUE INDEX user_email_key        ON velve.user (email)        WHERE email IS NOT NULL;
CREATE UNIQUE INDEX user_username_key_key ON velve.user (username_key) WHERE username_key IS NOT NULL;

-- The identity configuration is materialised as a CHECK constraint.
-- Exactly one of the following three is created by the migration:
--   email:          CHECK (email IS NOT NULL)
--   username:       CHECK (username IS NOT NULL)
--   username_email: CHECK (email IS NOT NULL AND username IS NOT NULL)

CREATE TABLE velve.password_credential (
  user_id     uuid PRIMARY KEY REFERENCES velve.user(id) ON DELETE CASCADE,
  phc         text NOT NULL,        -- canonical PHC string (3.3); final form bytea as ciphertext (L-2, 3.17)
  scheme      text NOT NULL,        -- redundant with phc, for evaluation without parsing
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE velve.identity (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
  provider           text NOT NULL,
  subject            text NOT NULL,   -- the stable ID at the provider, never the e-mail
  provider_email     text,
  provider_email_verified boolean NOT NULL DEFAULT false,
  profile            jsonb,           -- raw claims; the application reads them, the library does not
  access_token_enc   bytea,
  refresh_token_enc  bytea,
  id_token_enc       bytea,
  token_key_version  integer,
  scopes             text[],
  token_expires_at   timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_provider_subject UNIQUE (provider, subject)
);
CREATE INDEX identity_user_id_idx ON velve.identity (user_id);

CREATE TABLE velve.session (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
  token_sha256       bytea NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz NOT NULL DEFAULT now(),
  idle_expires_at    timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  factors            text[] NOT NULL DEFAULT '{}',  -- 'password','totp','webauthn','recovery','oauth'
  ip                 inet,
  user_agent         text,
  CONSTRAINT session_token_unique UNIQUE (token_sha256)
);
CREATE INDEX session_user_id_idx  ON velve.session (user_id);
CREATE INDEX session_sweep_idx    ON velve.session (absolute_expires_at);

CREATE TABLE velve.one_time_token (
  token_sha256 bytea PRIMARY KEY,
  purpose      text NOT NULL,   -- 'email_verify','password_reset','email_change','magic_link'
  user_id      uuid REFERENCES velve.user(id) ON DELETE CASCADE,
  payload      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX one_time_token_user_purpose_idx ON velve.one_time_token (user_id, purpose);
CREATE INDEX one_time_token_sweep_idx        ON velve.one_time_token (expires_at);

CREATE TABLE velve.pending_authentication (
  token_sha256      bytea PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
  factors_completed text[] NOT NULL,
  attempts          integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL
);
CREATE INDEX pending_authentication_sweep_idx ON velve.pending_authentication (expires_at);

CREATE TABLE velve.totp_credential (
  user_id       uuid PRIMARY KEY REFERENCES velve.user(id) ON DELETE CASCADE,
  secret_enc    bytea NOT NULL,
  key_version   integer NOT NULL,
  confirmed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE velve.totp_used_step (
  user_id    uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
  time_step  bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, time_step)
);
CREATE INDEX totp_used_step_sweep_idx ON velve.totp_used_step (expires_at);

CREATE TABLE velve.recovery_code (
  user_id   uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
  code_hmac bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, code_hmac)
);

CREATE TABLE velve.webauthn_credential (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
  credential_id    bytea NOT NULL,
  public_key       bytea NOT NULL,
  sign_count       bigint NOT NULL DEFAULT 0,
  transports       text[],
  aaguid           uuid,
  backup_eligible  boolean NOT NULL,   -- true  => synchronised passkey
  backup_state     boolean NOT NULL,   -- true  => currently backed up/synchronised
  user_verified_at_registration boolean NOT NULL,
  label            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_used_at     timestamptz,
  CONSTRAINT webauthn_credential_id_unique UNIQUE (credential_id)
);
CREATE INDEX webauthn_credential_user_idx ON velve.webauthn_credential (user_id);

CREATE TABLE velve.webauthn_challenge (
  challenge_sha256 bytea PRIMARY KEY,
  purpose          text NOT NULL,   -- 'register' | 'authenticate'
  user_id          uuid REFERENCES velve.user(id) ON DELETE CASCADE,  -- NULL for a discoverable sign-in
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
);
CREATE INDEX webauthn_challenge_sweep_idx ON velve.webauthn_challenge (expires_at);

CREATE TABLE velve.oauth_flow (
  state_sha256    bytea PRIMARY KEY,
  provider        text NOT NULL,
  pkce_verifier_enc bytea NOT NULL,
  key_version     integer NOT NULL,
  nonce           text,
  redirect_path   text,            -- a path, never a complete URL
  link_to_user_id uuid REFERENCES velve.user(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);
CREATE INDEX oauth_flow_sweep_idx ON velve.oauth_flow (expires_at);

CREATE TABLE velve.rate_bucket (
  bucket_key  text PRIMARY KEY,
  tokens      real NOT NULL,
  updated_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX rate_bucket_sweep_idx ON velve.rate_bucket (expires_at);

CREATE TABLE velve.schema_migration (
  version     integer PRIMARY KEY,
  name        text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  checksum    text NOT NULL
);
```

**Storage rule:** what the server only compares is hashed (session tokens,
one-time tokens, challenges, recovery codes). What it needs in cleartext
is encrypted (TOTP secret, third-party OAuth tokens, PKCE verifier). Passwords
are derived by KDF. **Nothing confidential lies in cleartext in the database.**

### 3.3 The password verification path

A single canonical storage string in the PHC family. The switch
decides on the prefix:

| Prefix | Scheme | Produce | Verify |
|---|---|---|---|
| `$argon2id$` | Argon2id (default) | yes | yes |
| `$argon2i$`, `$argon2d$` | Argon2 other variants | no | yes |
| `$2a$`, `$2b$`, `$2y$`, `$2x$` | bcrypt | no | yes |
| `$scrypt$` | scrypt (PHC) | no | yes |
| `$pbkdf2-sha256$`, `$pbkdf2-sha512$` | PBKDF2 | no | yes |
| `$fbscrypt$` | Firebase scrypt | no | yes |

**Normalisation:** every password is NFKC-normalised before every KDF call (NIST SP 800-63B-4 §3.1.1.2). Better Auth does the same, so its imported `$scrypt$` hashes verify unchanged. bcrypt sources (Supabase, Clerk, Auth0) and Firebase do not normalise; an imported hash of a password whose NFKC form differs from the entered bytes fails there and leads into the reset path from section 4.0. ESTIMATE: this affects only non-ASCII passwords in non-canonical Unicode form, a very small fraction of an existing population.

**A foreign raw format is never stored.** The import normalises every
source format into one of these strings. Better Auth's `salt_hex:hash_hex` becomes
`$scrypt$ln=14,r=16,p=1$<salt_b64>$<hash_b64>`. Firebase becomes
`$fbscrypt$v=1,n=<mem_cost>,r=<rounds>,p=1,ss=<b64>,sk=<b64>$<salt_b64>$<hash_b64>`
— the same format GoTrue already uses, so that Supabase populations
can be taken over unchanged.

Default parameters for Argon2id: **m = 19456 KiB, t = 2, p = 1, 32 byte output,
16 byte salt** (OWASP minimum recommendation). Configurable upwards.

Course of a password check:

1. Check the input length: reject under 8 characters, reject over 4096 bytes — **before** every KDF call (L-7).
2. Resolve the user. If none exists, the check runs against a **dummy PHC with the
   configured default parameters**. The code path is the same.
3. Switch on the prefix, call the verifier, compare the result in constant time.
4. On failure: a uniform response, no hint as to the cause.
5. On success: determine `needsRehash` — true if the scheme != the default **or**
   the parameters lie below the current policy.
6. If `needsRehash` is true, then after the response has been sent, a rehash happens in a bounded
   background task and is written by compare-and-swap:
   `UPDATE velve.password_credential SET phc = $neu, scheme = $s, key_version = $v,
    updated_at = now() WHERE user_id = $1 AND phc = $alt`.
   What is compared is the stored ciphertext (L-2); the same route carries the
   key rotation. If that fails, nothing is broken — the next login
   tries again. **Silent, without user interaction, part of the core.**

Concurrency: Argon2id occupies 19 MiB per call. The core holds a
**semaphore** over the concurrent KDF calls (default: `min(4, cpus)`),
so that concurrent sign-ins do not multiply the memory. Waiters
run into a wait limit of 5 seconds and are then rejected with `rate_limited`
instead of running into a memory error (L-1).

A known limitation that gets documented: **bcrypt truncates at 72 bytes.**
Imported bcrypt hashes check only the first 72 bytes. After the rehash to
Argon2id the full length applies.

### 3.4 The three identity configurations

Three configurations, chosen at initialisation via `identity.mode`
(3.15 A.3), materialised as a CHECK constraint in the migration:

| Configuration | Sign-in name | Unique | Reset/confirm via | Enumeration protection |
|---|---|---|---|---|
| `email` | e-mail | `email` | e-mail | complete |
| `username` | username | `username_key` | **not available** without recovery codes | not possible for the username |
| `username_email` | username **or** e-mail | both | e-mail | for the e-mail yes, for the username no |

Consequence that gets documented: **in `username` there is no reset by
e-mail.** Whoever chooses this configuration must issue recovery codes at
registration, otherwise a forgotten password is final; the way
back is then `password.redeemResetWithRecoveryCode` (3.15 B.4). The
library enforces this: `identity: { mode: "username" }` without `recoveryCodes`
is a start error and in TypeScript already a compile error (3.15 A.3).

Second consequence: **usernames are by definition enumerable.**
Whoever offers an availability check gives away existence. Velve Auth offers
it, limits it hard and says so in the documentation, instead of pretending
it were protected.

Normalisation in exactly one place:
- E-mail: trim, NFKC, `lower()`. The database checks afterwards via CHECK.
- Username: NFKC, `toLowerCase()` into `username_key`; the display form is preserved.
  In addition a configurable character-class allowlist (default:
  `[a-z0-9_-]`, 3–32 characters) — that is the most effective protection against homoglyphs,
  because it does not admit them in the first place.

### 3.5 Session model

- Token: 32 bytes from `crypto.getRandomValues`, base64url — 256 bit.
- **Only `sha256(token)`** is stored. The cleartext token leaves the
  process only in the cookie.
- Cookie: `__Host-velve_session`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`.
  The `__Host-` prefix forces `Secure` and forbids `Domain` — cookie tossing
  from a subdomain is thereby ruled out.
- Two deadlines: **idle** (default 7 days, extended on use, written at most
  once per hour) and **absolute** (default 30 days, never extended).
- Resolution: **one** query with a join on `velve.user`, filtered by
  `token_sha256 = $1 AND idle_expires_at > now() AND absolute_expires_at > now()`.
  `u.disabled_at` is read in the same query: if it is set, the
  session does not count as signed in, and the response is `account_disabled` — the
  only place at which this code appears (L-4). A deactivation thereby takes effect
  on the next request of every existing session.
- **Freshness:** a session counts as fresh as long as less
  than `freshnessWindow` (default 15 minutes) has passed since `created_at`. Operations on
  credentials require freshness (3.15 B.9); it is restored only
  by a new sign-in, because a re-authentication without reissue
  would be a second notion of trust alongside `factors`.
- **No cookie cache in the core.** Authorisation decisions are never answered from
  a cache; that is exactly what Better Auth's worst bug in the
  core sign-in path hung on (GHSA-xg6x-h9c9-2m83, CVSS 9.1: 2FA bypass, because the
  cookie cache stored the session before the second-factor check).
- **Metadata truncated:** `ip` and `user_agent` are by default stored truncated
  — IPv4 to `/24`, IPv6 to `/64`, user agent to browser and
  system family (L-10, option `sessionMetadata`).
- **Reissue** on every event that changes the level of trust: sign-in,
  completion of the second factor, password change, linking of a new
  identity. Always as an `INSERT` of a new row plus a `DELETE` of the old one in
  **one** transaction. An `UPDATE velve.session SET user_id` does not exist
  and is prevented by a lint rule and a database trigger.
- **Revocation:** individually, all except the current one, all. Password reset and
  password change revoke **by default** all other sessions. That is
  not a switch.
- `factors` records what was authenticated with. That is not a permission
  but part of the answer to "who is signed in, and how securely".

### 3.6 The second factor and the intermediate state

The moment between a correct password and the second factor is **not a session**.
It is a row in `velve.pending_authentication`, the token lies in a
short-lived cookie of its own (`__Host-velve_pending`, 5 minutes), and exactly **four**
routes accept it: `POST /factor/totp/verify`, `/factor/webauthn/authenticate/start`,
`/factor/webauthn/authenticate/finish` and `POST /factor/recovery/verify`. Every
other route ignores it entirely. An intermediate state permits at most
five attempts; after that the row is deleted, and the procedure starts again from the
password (L-8).

- **TOTP:** RFC 6238, SHA-1, 6 digits, 30 s, tolerance ±1 step. Secret
  AES-256-GCM-encrypted. Replay protection via `velve.totp_used_step` with
  primary key `(user_id, time_step)` — an `INSERT` that fails on conflict
  is the check.
- **WebAuthn:** a full sign-in route of its own, not only a second factor.
  - *Passkey sign-in* (discoverable credentials, `userVerification: "required"`)
    yields a session with `factors = {webauthn}` — without a password.
  - *Second factor* after a password yields `factors = {password, webauthn}`.
  - **Device-bound vs. synchronised** is distinguished and stored via the flags `backup_eligible`
    (BE) and `backup_state` (BS) from the authenticator data. `BE = false` means device-bound. The application can base
    a policy on it; the library enforces none.
  - Challenge single-use, 5 minutes, consumed via `DELETE … RETURNING`, bound to the
    purpose (`register`/`authenticate`).
  - `sign_count` is checked: if it drops, that is reported to the application as the field
    `signCountRegressed` in the sign-in result, not as an error (L-9).
- **Recovery codes:** 10 of them, 160 bit each, displayed in groups.
  Stored as `HMAC-SHA256(pepper, code)` — looking one up is an
  index hit, not a scan. Consumption via `DELETE … RETURNING`. On a
  change of scheme all are generated anew and the old ones deleted in the same
  transaction.

### 3.7 One-time artefacts

Every one-time artefact is a row with `sha256(token)` as the primary key,
a `purpose` and an `expires_at`. Consumption is **always**:

```sql
DELETE FROM velve.one_time_token
WHERE token_sha256 = $1 AND purpose = $2 AND expires_at > now()
RETURNING user_id, payload;
```

One result means valid, no result means invalid — expired, used up
and never existed are indistinguishable from the outside. That is intentional.

Deadlines: e-mail confirmation 24 h, password reset 1 h, e-mail change 1 h,
magic link 10 min. A newly requested token of the same purpose deletes the
previous ones of the same user.

### 3.8 Key management

One root key, and from it, by **HKDF-SHA256**, purpose-separated keys:
`cookie-sig`, `token-pepper`, `totp-enc`, `oauth-token-enc`, `pkce-enc`, `password-enc`.
Every value produced carries its key version in the envelope. A ring
of accepted versions permits rotation without an outage.

```ts
interface KeyProvider {
  current(purpose: KeyPurpose): Promise<{ version: number; key: CryptoKey }>
  byVersion(purpose: KeyPurpose, version: number): Promise<CryptoKey | null>
}
```

The default implementation `rootKeyProvider` (3.15 A.8) reads the
root key from the configuration. ESTIMATE: on Caprock it would be passed as a
capability, without anything changing for the caller; that is
unverified. **Because sessions are opaque database rows, every
key rotation survives all sessions.**

### 3.9 Rate limiting

Token bucket in PostgreSQL, one round trip:

```sql
INSERT INTO velve.rate_bucket (bucket_key, tokens, updated_at, expires_at)
VALUES ($1, $2 - 1, now(), now() + $3)
ON CONFLICT (bucket_key) DO UPDATE
SET tokens = LEAST($2, velve.rate_bucket.tokens
      + EXTRACT(EPOCH FROM now() - velve.rate_bucket.updated_at) * $4) - 1,
    updated_at = now(),
    expires_at = now() + $3
RETURNING tokens;
```

Negative means rejected. Three counters at once:
- **IP:** normalised to `/32` (v4) and **`/64` (v6)** respectively — the prefix, not the
  address, otherwise an attacker rotates at will (CVE-2026-45364).
  `X-Forwarded-For` is evaluated **only** if `trustedProxies` is configured;
  without that the connection address counts.
- **Account:** a bucket with a slowly refilling rate instead of a lock, and exceeding it leads to **rejection**, not to a delay (L-5). A lock is a
  denial of service against a known user.
- **Global per route:** no rejection, but an alarm callback.

The key contains the **resolved route name**, not the raw path —
`//sign-in` and `/sign-in` are the same counter (GHSA-x732-6j76-qmhm).

### 3.10 Third-party sign-in

Authorisation code flow with **PKCE S256 mandatory**, `state` server-side
in `velve.oauth_flow` (the cookie holds only the pointer), `nonce` with OIDC, checking
of `iss` per RFC 9207, ID token signature against JWKS.

Providers at the start: Google, GitHub, Apple, Microsoft/Entra, GitLab, Discord,
Facebook, LinkedIn, Twitch, Spotify, Slack, Notion, Zoom, Dropbox — plus
`genericOAuth` for everything further. No race for 36 providers; the interface
is the value, not the number.

**Linking rule, not negotiable:**
`(provider, subject)` is the only key. **The e-mail is never a
linking key.** Automatic linking with an existing account happens
only if *all* the conditions hold:
1. The provider reports the e-mail as verified.
2. The local account has `email_verified_at IS NOT NULL`.
3. The provider is in `trustedProviders`.

Otherwise: a new account or explicit linking within an existing session.
Until CVE-2026-53516 (CVSS 8.3), Better Auth never read the second condition — the
auto-link gate checked only the provider's `emailVerified` claim. Even after the
fix the conditions there are not all mandatory: a trustworthy
provider replaces the first, and the second can be switched off via
`accountLinking.requireLocalEmailVerified`
(`packages/better-auth/src/oauth2/link-account.ts:144-158`). GHSA-qq9h-g4jm-xgf3
is the same pattern on the magic link route; there L-12 closes the gap.

**No account under e-mail compulsion:** if the provider reports no e-mail,
`user.email` stays NULL in the configurations `username`/`username_email`. There are
**no placeholder addresses invented** — Better Auth does that with
`createPlaceholderEmail` (`packages/core/src/utils/email.ts:24`) in nine
places in eight modules of the production code and thereby breaks every
e-mail plugin.

Third-party tokens are stored encrypted or, if the application does not
need them, not at all (`storeTokens: false` is the default).

### 3.11 Plugin interface

**What a plugin may do:**
- Contribute routes under its own namespace `/x/<plugin-id>/…`.
- Create tables of its own in the schema `velve` with the prefix `<plugin-id>_`; migrations
  run in the same versioned runner.
- Listen in at declared points: `beforeSignIn`, `afterSignIn`,
  `beforeSessionCreate`, `afterSessionCreate`, `beforeUserCreate`,
  `afterUserCreate`, `beforeSessionRevoke`. A hook may **reject** (throw an
  error) or **observe**. It may not replace the response.
- Contribute error codes and rate limiting rules of its own.
- Declare dependencies (`dependsOn`), which are sorted topologically.

**What a plugin may not do:**
- Override core routes. A name conflict is a **start error**, not a warning.
- Change the core context. The context is frozen (`Object.freeze`).
- Replace the password verifier, the session resolution or the origin check.
- Write to core tables directly. Only repository methods, and every one requires
  an `actor`.
- Read or write other plugins' options.
- Run before the security middleware. The origin check and rate limiting
  always lie ahead of it — including for direct server calls.

Core decision: the extension points are **enumerated**, not open.
A plugin is a listener with a right of veto, not a co-owner of the core.

### 3.12 The interface at a glance

Every route is declared **once** — path, method, input schema,
output type, error codes. From this declaration are generated: the
server handler, the directly callable server method and the client (3.15 D and E).
This is what wiring it in looks like; 3.15 contains every signature:

```ts
const auth = createVelveAuth({
  database: pg(pool),
  identity: { mode: "email" },        // or "username" | "username_email", then with username rules
  keys: rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: process.env.VELVE_ROOT_KEY! } }),
  password: { argon2id: { memoryKiB: 19456, iterations: 2, parallelism: 1 } },
  session: { idleTimeout: "7d", absoluteTimeout: "30d" },
  origins: ["https://app.example.com"],
  email: { send: async (message) => { … } },

})

await auth.signUp.withPassword({ … })
await auth.signIn.password({ … })
await auth.session.resolve(token)
export default toWebHandler(auth)   // (Request) => Promise<Response>
```

### 3.13 Error handling

Two kinds of error:

- **Visible:** input invalid, rate limit reached, token expired, second factor
  required. These carry a stable code. Account disabled explicitly does **not** belong here as long as it is about a sign-in (L-4); the code appears only when an existing session is resolved.
- **Deliberately invisible:** everything that would reveal existence. Sign-in,
  sign-up, password reset and email change return, for accounts that exist and
  accounts that do not, **byte-for-byte identical** responses — same status,
  same headers, same body. The difference moves exclusively into the email that
  is sent.

Sign-up with an email address already taken: the same response as on success, and
a message "somebody tried to sign up with your address" goes to the existing
address, with a sign-in link instead of a confirmation link.

On the server side the true reason is always logged. The difference between
inside and outside is explicit and lies at exactly one place in the code.

### 3.14 What is deliberately absent

No roles, no permissions, no organisations, no teams, no invitations, no SCIM,
no SAML, no OAuth server of its own, no profile data, no admin interface, no
audit log, no email sending (only a callback), no subscription or billing module.

### 3.15 The public interface in detail

This section spells out the sketch from 3.12 in full: types, signatures, semantics,
no function bodies. Four design rules carry the surface; they implement the requirement
of the build brief that the code must be understandable without comments and the
interface usable without documentation.

1. **No boolean parameters.** `revokeAllOther()` and `revokeAll()` instead of
   `revoke({ includeCurrent })`.
2. **One verb pair per kind of flow.** Two-step ceremonies with a challenge are always
   called `start`/`finish`, one-time artefacts delivered by email always `request…`/`redeem…`.
3. **No ambient state.** No implicit "current user"; every method takes a named
   `sessionToken`, `pendingToken` or `userId`.
4. **Options describe the call, not the behaviour.** No parameter has more than five
   fields, and none of them changes the meaning of the method.

---

#### A) Configuration

##### A.1 The identity mode is the library's type parameter

`createVelveAuth` is generic over the mode, the mode is inferred from the configuration,
and everything downstream — input fields, whole namespaces — hangs off it.

```ts
type IdentityMode = "email" | "username" | "username_email"

interface IdentityFieldsByMode {
  email:          { email: string }
  username:       { username: string }
  username_email: { email: string; username: string }
}
interface SignInLookupByMode {
  email:          { email: string }
  username:       { username: string }
  username_email: { emailOrUsername: string }
}
type IdentityFields<M extends IdentityMode> = IdentityFieldsByMode[M]
type SignInLookup<M extends IdentityMode>  = SignInLookupByMode[M]

type ModeHasEmail<M extends IdentityMode>    = M extends "email"    | "username_email" ? true : false
type ModeHasUsername<M extends IdentityMode> = M extends "username" | "username_email" ? true : false
```

Lookup tables instead of conditional types spread about: one row per mode, readable without `infer`.
In mode `username_email` the sign-in field is called `emailOrUsername` and not two optional
fields — a call with both would otherwise be neither a type error nor defined semantics.

How does a namespace the mode does not offer disappear? *Design A:* the key
stays, its type becomes `never`; the error appears only on method access, as "Property
'change' does not exist on type 'never'". *Design B:* the key is removed; the error
reads "Property 'username' does not exist on type `VelveAuth<"email">`". **Decision: B** —
the error message is the only thing the caller gets to read without documentation, and
it must name the mode.

```ts
type PresentKeys<S> = { [K in keyof S]-?: [S[K]] extends [never] ? never : K }[keyof S]
type Prune<S> = { [K in PresentKeys<S>]: S[K] }
type OnlyWhen<Condition extends boolean, S> = Condition extends true ? S : never
```

##### A.2 `VelveAuthConfig`

```ts
type Duration = `${number}${"s" | "m" | "h" | "d"}`
type VelveAuthConfig<M extends IdentityMode> = BaseConfig<M> & RecoveryCodesRequirement<M>
```

Fields with a default are optional in the configuration; the types in A.4 to A.8 show the
resolved form. `Driver` (3.2) comes from one of the three driver factories:

```ts
declare function pg(pool: import("pg").Pool): Driver                       // @velve/auth/pg
declare function postgresJs(sql: import("postgres").Sql): Driver           // @velve/auth/postgres-js
declare function neon(pool: import("@neondatabase/serverless").Pool): Driver  // @velve/auth/neon
```

| Field of `BaseConfig<M>` | Type | Default | Meaning |
|---|---|---|---|
| `database` | `Driver` | — | Driver from `@velve/auth/pg`, `/postgres-js`, `/neon`; the only place at which a connection comes in. |
| `identity` | `IdentityConfig<M>` | — | Which sign-in names there are; determines the CHECK constraint and the instance type. |
| `keys` | `KeyProvider` | — | Root key and ring; all six purpose keys (3.8) arise from it by HKDF-SHA256. |
| `origins` | `readonly string[]` | — | Allowed origins; an empty list is a start error, not a silent free pass. |
| `password` | `PasswordConfig` | A.4 | Argon2id parameters, legacy schemes, length limits, semaphore limit, hook point `validate`. |
| `session` | `SessionConfig` | A.5 | Lifetimes, cookie name, cookie options, freshness window. |
| `sessionMetadata` | `"truncated" \| "full" \| "none"` | `"truncated"` | Truncation of `ip` and `user_agent` in `velve.session` (L-10). |
| `trustedProxies` | `readonly string[]` | `[]` | CIDR blocks whose `X-Forwarded-For` counts; otherwise the connection address counts. |
| `rateLimit` | `RateLimitConfig` | A.6 | Bucket sizes, alert callback. |
| `email` | `EmailConfig` | none | Send callback; its absence is a start error in `email` and `username_email`. |
| `oauth` | `OAuthConfig` | none | Providers, trusted providers, token storage. |
| `webauthn` | `WebAuthnConfig` | none | Relying party; its absence removes all WebAuthn routes. |
| `totp` | `TotpConfig` | A.8 | Issuer name and tolerance window. |
| `recoveryCodes` | `RecoveryCodesConfig` | none; in mode `username` **mandatory** | Number and grouping of the recovery codes. |
| `plugins` | `readonly VelvePlugin[]` | `[]` | Extensions; a name conflict is a start error. |
| `schema` | `string` | `"velve"` | Postgres schema name. |
| `clock` | `Clock` | system clock | Time source; replaceable from `@velve/auth/testing`. |

##### A.3 `identity` and the enforced recovery codes

```ts
type IdentityConfig<M extends IdentityMode> =
  M extends "email"      ? { mode: "email" }
  : M extends "username" ? { mode: "username"; username: UsernameRules }
  : { mode: "username_email"; username: UsernameRules }

interface UsernameRules {
  allowedCharacters: RegExp          // default /^[a-z0-9_-]+$/
  minimumLength: number              // default 3
  maximumLength: number              // default 32
  reservedNames: readonly string[]   // default []
}

type RecoveryCodesRequirement<M extends IdentityMode> =
  M extends "username" ? { recoveryCodes: RecoveryCodesConfig }
                       : { recoveryCodes?: RecoveryCodesConfig }
```

`identity` is an object and not a string literal, because 3.4 demands a configurable
character allowlist and length limits, which a string cannot carry; a string shorthand is
not accepted in addition, because two spellings for the same thing contradict
documentation-free usability. Section 3.4 demands that mode
`username` without recovery codes is a **start error**. A start error is the
second-best solution: `RecoveryCodesRequirement` turns it into a compile error. The
runtime check remains for callers from JavaScript.

##### A.4 `password`, A.5 `session`, A.6 `rateLimit`

```ts
interface PasswordConfig {
  argon2id: { memoryKiB: number; iterations: number; parallelism: number }  // 19456, 2, 1
  acceptLegacy: readonly LegacyScheme[]         // default: all seven
  minimumLength: number                         // default 8
  maximumLengthInBytes: number                  // default 4096, not configurable upwards
  concurrentHashLimit: number                   // default min(4, cpus)
  validate?: (plaintext: string) => Promise<void>   // L-7: only on setting and changing
}
type LegacyScheme = "argon2i" | "argon2d" | "bcrypt" | "scrypt"
  | "pbkdf2-sha256" | "pbkdf2-sha512" | "fbscrypt"

interface SessionConfig {
  idleTimeout: Duration          // default "7d"
  absoluteTimeout: Duration      // default "30d"
  idleWriteInterval: Duration    // default "1h"
  freshnessWindow: Duration      // default "15m"
  cookieName: `__Host-${string}` // default "__Host-velve_session"
  cookie: { sameSite: "lax" | "strict" }                      // default "lax"
}

interface BucketRule { capacity: number; refillPerSecond: number }
interface RateLimitConfig {
  perIpAddress: BucketRule       // default { capacity: 10, refillPerSecond: 0.1 }
  perAccount: BucketRule         // default { capacity: 5, refillPerSecond: 0.01 }
  globalPerRoute: { alertThresholdPerMinute: number; onAlert: (alert: RateAlert) => void }
}
interface RateAlert { routeName: string; requestsInLastMinute: number; observedAt: Date }
```

`memoryKiB` below 19456 is a start error — a lower bound one is allowed to fall below
is not one. Both lengths are checked **before** every KDF call; what is produced is
exclusively Argon2id, `acceptLegacy` governs only the verification of imported stock.
`validate` is the only hook point for a password policy of the application, a check against
leak corpora for instance; it runs on setting and changing and never on sign-in, so that the
plaintext password on the hot path reaches no foreign code (L-7).

`httpOnly`, `secure`, `domain` and `path` are not options: the `__Host-` prefix enforces
`Secure` and `Path=/` and forbids `Domain`; a configurable `domain` would reopen
cookie tossing from a subdomain, and `sameSite: "none"` is absent for the same reason.
A `cookieName` without `__Host-` is a type error and a start error. `freshnessWindow` measures
against `created_at`, not against `last_used_at` — freshness is the time since sign-in (3.5);
it concerns 17 methods (B.9). The IP normalisation to `/32` (v4) and `/64`
(v6) respectively is not configurable. `perIpAddress` and `perAccount` apply to the routes that
accept passwords, codes or tokens; the remaining routes carry further, fixed buckets
in their declaration (D.2). The account counter is formed on the HMAC of the identifier
entered and refuses on exceedance, instead of delaying or locking (L-5); the
global counter never refuses, but calls `onAlert`.

##### A.7 `email` — the send callback and the complete message type

```ts
interface EmailConfig { send: (message: EmailMessage) => Promise<void> }

type EmailMessage =
  | { kind: "email_verification"; to: string; userId: string; token: string; expiresAt: Date }
  | { kind: "password_reset";     to: string; userId: string; token: string; expiresAt: Date }
  | { kind: "email_change";       to: string; userId: string; token: string; expiresAt: Date
      previousEmail: string }
  | { kind: "magic_link";         to: string; userId: string; token: string; expiresAt: Date }
  | { kind: "sign_up_attempt_on_existing_account"; to: string; userId: string }
  | { kind: "request_for_unknown_address"; to: string; requested: "password_reset" | "magic_link" }
```

Four kinds correspond to the four `purpose` values from `velve.one_time_token`. The fifth is the
other side of enumeration resistance: a sign-up on an address already taken returns
the same response as a success, and the difference moves entirely into this message.
It deliberately carries **no** token — it leads to a sign-in, not to a confirmation that
nobody asked for. The sixth follows from L-1: a reset or magic link for an
unknown address calls `send` just as it does for a known one, so that both branches do the same
work; whether that becomes a "no account exists here" message or nothing is
decided by the application in the callback.

The library builds no URLs; a `redirectTo` that comes from a request and would have to be
checked against an allowlist therefore does not exist at all. If `send` throws, the
triggering operation fails and the one-time token is rolled back: a reset token whose mail
never arrived is of use only to an attacker.

##### A.8 `oauth`, `webauthn`, `totp`, `recoveryCodes`, `keys`, `clock`

```ts
interface OAuthConfig {
  providers: Partial<Record<KnownProvider, ProviderCredentials>>
           & { [customId: string]: GenericProviderConfig }
  trustedProviders: readonly string[]
  storeTokens: boolean                          // default false
}
type KnownProvider = "google" | "github" | "apple" | "microsoft" | "gitlab" | "discord"
  | "facebook" | "linkedin" | "twitch" | "spotify" | "slack" | "notion" | "zoom" | "dropbox"
interface ProviderCredentials { clientId: string; clientSecret: string; scopes?: readonly string[] }
interface GenericProviderConfig extends ProviderCredentials {
  authorizationEndpoint: string; tokenEndpoint: string; userInfoEndpoint?: string
  issuer?: string; jwksUri?: string
  subjectClaim: string                          // without a default, on purpose
}

interface WebAuthnConfig {
  relyingPartyId: string                        // the eTLD+1, e.g. "example.com"
  relyingPartyName: string; origins: readonly string[]
  userVerification: "required" | "preferred"
}
interface TotpConfig          { issuer: string; stepToleranceInSteps: 0 | 1 }  // default 1
interface RecoveryCodesConfig { count: number; groupSize: number }             // defaults 10, 5

type KeyPurpose = "cookie-sig" | "token-pepper" | "totp-enc" | "oauth-token-enc" | "pkce-enc" | "password-enc"
interface KeyProvider {
  current(purpose: KeyPurpose): Promise<{ version: number; key: CryptoKey }>
  byVersion(purpose: KeyPurpose, version: number): Promise<CryptoKey | null>
}
declare function rootKeyProvider(input: { currentVersion: number
  keysByVersion: Readonly<Record<number, string>> }): KeyProvider   // base64url, 32 bytes each
interface Clock { now(): Date }
```

`subjectClaim` deliberately has no default: the stable provider ID is the only
linking key, and `"sub"` would be convenient and, in the one case in which it is wrong, an
account takeover fault. `trustedProviders` is the third of the three conditions for automatic
linking; whoever is not in it never leads to one. `webauthn.origins` is an array, because
a relying party with a web and a native app legitimately has several origins; a single
string would force a second instance with the same `relyingPartyId`.
`userVerification: "discouraged"` is absent, because a second factor without user verification
is not one, and for discoverable passkey sign-in `"required"` always applies.

---

#### B) The instance

```ts
declare function createVelveAuth<M extends IdentityMode>(config: VelveAuthConfig<M>): VelveAuth<M>

type VelveAuth<M extends IdentityMode> = Prune<AuthSurface<M>> & AuthInternals

interface AuthSurface<M extends IdentityMode> {
  signUp:   SignUpNamespace<M>
  signIn:   SignInNamespace<M>
  signOut:  (input: { sessionToken: SessionToken }) => Promise<void>
  session:  SessionNamespace
  user:     UserNamespace<M>
  password: PasswordNamespace<M>
  factor:   { totp: TotpNamespace; webauthn: WebAuthnNamespace; recovery: RecoveryNamespace }
  identity: IdentityNamespace
  pending:  PendingNamespace
  email:    OnlyWhen<ModeHasEmail<M>,    EmailNamespace>
  username: OnlyWhen<ModeHasUsername<M>, UsernameNamespace>
}

interface AuthInternals {
  readonly routes: readonly AnyRoute[]
  readonly identityMode: IdentityMode
  readonly errorCodes: readonly VelveErrorCode[]
  readonly maintenance: { sweep(): Promise<SweepReport> }        // L-11, without an HTTP route
  migrate(): Promise<MigrationReport>
  close(): Promise<void>
}
interface MigrationReport { appliedVersions: readonly number[]; currentVersion: number }
interface SweepReport     { deletedRowsByTable: Readonly<Record<string, number>> }
```

`routes` is not an implementation detail but the data structure from which part D builds the
HTTP handler and part E the client. It is present at run time, because otherwise the client
would have to guess. `AuthSurface` has 54 methods in mode `username_email`, 51 in `email`, 45 in
`username`. `maintenance.sweep` deletes expired rows from the seven tables with
`*_sweep_idx` (L-11); `@velve/auth/schema` delivers the same as SQL for `pg_cron`.

##### B.1 `signUp` (2), `signIn` (7), `signOut` (1)

```ts
interface SignUpNamespace<M extends IdentityMode> {
  withPassword(input: IdentityFields<M> & { password: string }): Promise<SignUpResult>
  withoutPassword(input: IdentityFields<M>): Promise<SignUpResult>
}
type SignUpResult = { user: User; sessionToken: SessionToken; session: Session }

interface SignInNamespace<M extends IdentityMode> {
  password(input: SignInLookup<M> & { password: string }): Promise<SignInResult>
  passkey: {
    start(): Promise<PasskeyAuthenticationChallenge>
    finish(input: { challengeToken: string; response: AuthenticatorAssertion }): Promise<SignInResult>
  }
  oauth: {
    start(input: { provider: string; redirectPath?: string }): Promise<OAuthRedirect>
    finish(input: { provider: string; code: string; state: string; issuer?: string })
      : Promise<OAuthCallbackResult>
  }
  magicLink: OnlyWhen<ModeHasEmail<M>, {
    request(input: { email: string }): Promise<void>
    redeem(input: { token: string }): Promise<SignInResult>
  }>
}
```

`signUp` is a namespace with two methods instead of a function with an optional `password`,
because the two paths produce different `factors` (rule 1): `withPassword` creates the user and the
`password_credential` in one transaction, `factors = ["password"]`; `withoutPassword` creates
only the user, for applications that begin with a passkey or a magic link.

`signIn.password` resolves in mode `username_email` on the format: with an `@` against `email`, otherwise
against `username_key`; both branches run through the same dummy PHC path when nothing is
found. `magicLink.request` returns `void`, not `{ sent: boolean }` — a boolean
return value would be exactly the enumeration disclosure that 3.13 forbids. `signIn.passkey.*` is
the discoverable sign-in without a password (`factors = ["webauthn"]`) and not the same as
`factor.webauthn.authenticate.*`, which presupposes an intermediate state: precondition (no
token against `pendingToken`), user verification (always `required` against configurable) and
result (`["webauthn"]` against `["password", "webauthn"]`) differ, and a
shared namespace with a mode parameter would be the boolean parameter that rule 1
rules out. `signOut` deletes exactly one session row; an unknown token is not an error.

##### B.2 `session` (7)

```ts
interface SessionNamespace {
  resolve(token: SessionToken): Promise<ResolvedSession | null>
  resolveFromHeaders(headers: Headers): Promise<ResolvedSession | null>
  list(input: { sessionToken: SessionToken }): Promise<Session[]>
  revoke(input: { sessionToken: SessionToken; targetSessionId: string }): Promise<void>
  revokeAllOther(input: { sessionToken: SessionToken }): Promise<{ revokedCount: number }>
  revokeAll(input: { sessionToken: SessionToken }): Promise<{ revokedCount: number }>
  refresh(input: { sessionToken: SessionToken }): Promise<ResolvedSession | null>
}
interface ResolvedSession { session: Session; user: User }
```

`resolve` is the library's only authorisation decision and it answers it
**always** from a query against the database: no cookie cache, no short-circuit variant,
no parameter that could introduce one — that is exactly what the worst known fault in the
sign-in path of the comparison system hung on (3.5). An unknown or expired token yields `null`;
a valid token on a disabled account throws `account_disabled` (L-4). As a
side effect `resolve` extends the idle lifetime, at most once per `idleWriteInterval`;
`refresh` forces exactly this write and nothing else — never the absolute lifetime, never
a new token, because a method that could extend the absolute lifetime would be the end of the
absolute lifetime. `revoke` takes a `targetSessionId`, not a second token — the token
of a foreign session is not available to the caller and is not meant to be; the return
is `void` even for a missing or foreign row, as otherwise the method would be a disclosure about
foreign session IDs.

##### B.3 `user` (6, without HTTP routes)

```ts
interface UserNamespace<M extends IdentityMode> {
  findById(input: { userId: string }): Promise<User | null>
  disable(input: { userId: string; reason: string }): Promise<void>
  enable(input: { userId: string }): Promise<void>
  delete(input: { userId: string }): Promise<void>
  findByEmail:    OnlyWhen<ModeHasEmail<M>,    (i: { email: string })    => Promise<User | null>>
  findByUsername: OnlyWhen<ModeHasUsername<M>, (i: { username: string }) => Promise<User | null>>
}
```

This namespace is the surface that the application calls in its own process, **after** it has
made its own authorisation decision. Velve Auth has no permission model
and cannot decide who may call `disable`; accepting that unchecked over HTTP
would be the opposite of a safeguard. `disable` sets `disabled_at` and leaves
the session rows standing: every further request with one of their tokens ends at resolution
with `account_disabled` (L-4, 3.5), until `enable` releases the account or the lifetimes expire.
`enable` exists because a deactivation without a counterpart could be undone only by direct
SQL. `reason` is not stored (3.14 rules out an audit log) but
logged, and forces the caller to formulate the reason at the call site.

**No `user.update`:** apart from the sign-in names `velve.user` has no mutable fields,
and both have their own namespaces with confirmation flows; a `user.update` would be either
empty or a second door past the confirmations.

##### B.4 `password` (5)

```ts
interface PasswordNamespace<M extends IdentityMode> {
  set(input: { sessionToken: SessionToken; newPassword: string }): Promise<SetPasswordResult>
  change(input: { sessionToken: SessionToken; currentPassword: string; newPassword: string })
    : Promise<SetPasswordResult>
  redeemResetWithRecoveryCode(input: SignInLookup<M> & { recoveryCode: string; newPassword: string })
    : Promise<SetPasswordResult>
  requestReset: OnlyWhen<ModeHasEmail<M>, (i: { email: string }) => Promise<void>>
  redeemReset:  OnlyWhen<ModeHasEmail<M>, (i: { token: string; newPassword: string })
    => Promise<SetPasswordResult>>
}
interface SetPasswordResult {
  sessionToken: SessionToken            // new; the old one is invalid
  session: Session
  revokedOtherSessionsCount: number
}
```

All four writing methods revoke **all other** sessions and return a new token.
That is not a switch; a field `revokeOtherSessions` does not exist. `set` is for
accounts without a password credential and fails when one already exists — two methods
instead of an optional `currentPassword`, because an optional current password is exactly the
gap through which one overwrites foreign passwords. `redeemResetWithRecoveryCode` is the
path that 3.4 presupposes in mode `username`; it consumes the code by `DELETE … RETURNING`
and produces no new ones. `validate` from A.4 runs before hashing in all four methods.

##### B.5 `email` (4) and `username` (2)

```ts
interface EmailNamespace {
  requestVerification(input: { sessionToken: SessionToken }): Promise<void>
  redeemVerification(input: { token: string }): Promise<{ user: User }>
  requestChange(input: { sessionToken: SessionToken; newEmail: string }): Promise<void>
  redeemChange(input: { token: string }): Promise<{ user: User }>
}
interface UsernameNamespace {
  isAvailable(input: { username: string }): Promise<{ available: boolean; reason?: UnavailableReason }>
  change(input: { sessionToken: SessionToken; newUsername: string }): Promise<{ user: User }>
}
type UnavailableReason = "taken" | "reserved" | "invalid_characters" | "wrong_length"
```

`requestVerification` takes no `email` field: the address to be confirmed is the one on the account;
an address as a parameter would be an open enumeration interface. `requestChange` returns
`void` even when `newEmail` belongs to another account (internally
`email_taken_on_change`); the uniqueness check is repeated on redemption, because
an hour lies in between. `redeemChange` sets `email_verified_at` to `now()` — the user
has proved the address by the redemption.

`username.isAvailable` is the place at which enumeration resistance ends, and the type says so.
The alternative — leaving it out and giving the information only as an error on `change` and `signUp` —
would not have prevented enumeration, only slowed it down, and at the same time made the
sign-up form worse. **Decision: offer it, limit it hard** (its own bucket: 10 requests per
minute per IP prefix) **and name it.**

##### B.6 `factor.totp` (4), `factor.webauthn` (7), `factor.recovery` (3)

```ts
interface TotpNamespace {
  enroll: {
    start(input: { sessionToken: SessionToken }): Promise<TotpEnrollment>
    finish(input: { sessionToken: SessionToken; code: string }): Promise<void>
  }
  verify(input: { pendingToken: PendingToken; code: string }): Promise<SignInResult>
  remove(input: { sessionToken: SessionToken; code: string }): Promise<void>
}
interface TotpEnrollment { secretBase32: string; otpauthUri: string }

interface WebAuthnNamespace {
  register: {
    start(input: { sessionToken: SessionToken }): Promise<WebAuthnRegistrationChallenge>
    finish(input: { sessionToken: SessionToken; challengeToken: string
                    response: AuthenticatorAttestation; label: string })
      : Promise<{ credential: WebAuthnCredential }>
  }
  authenticate: {
    start(input: { pendingToken: PendingToken }): Promise<WebAuthnAuthenticationChallenge>
    finish(input: { pendingToken: PendingToken; challengeToken: string
                    response: AuthenticatorAssertion }): Promise<SignInResult>
  }
  list(input: { sessionToken: SessionToken }): Promise<WebAuthnCredential[]>
  rename(input: { sessionToken: SessionToken; credentialId: string; label: string })
    : Promise<{ credential: WebAuthnCredential }>
  remove(input: { sessionToken: SessionToken; credentialId: string }): Promise<void>
}

interface RecoveryNamespace {
  generate(input: { sessionToken: SessionToken }): Promise<{ codes: readonly string[] }>
  verify(input: { pendingToken: PendingToken; code: string }): Promise<SignInResult>
  remaining(input: { sessionToken: SessionToken }): Promise<{ remainingCount: number }>
}
```

`totp.enroll.start` writes a row with `confirmed_at = NULL`; as long as it is NULL,
the factor counts as not present — an abandoned enrolment attempt is a data remnant, not a
locked-out user. `totp.remove` demands a valid code: whoever can remove the factor without
possession has no factor.

`webauthn.register.finish` demands a `label` as a mandatory field — a list with three entries
called "security key" is not a list from which somebody can remove one, and the
AAGUID knows only the model, not the device. `webauthn.remove` fails with
`last_sign_in_method` when this is the last sign-in method (B.7); a regressing
`sign_count` is **not** an error but the field `signCountRegressed` (L-9).

`recovery.generate` always produces the complete set and deletes all previous ones — a
partially renewed set is a set whose age nobody knows; the plaintext codes leave
the process exactly here, exactly once. `remaining` returns only a number, what is stored is
`HMAC-SHA256(pepper, code)`.

##### B.7 `identity` (3) and `pending` (3)

```ts
interface IdentityNamespace {
  list(input: { sessionToken: SessionToken }): Promise<Identity[]>
  linkOAuth: {
    start(input: { sessionToken: SessionToken; provider: string; redirectPath?: string })
      : Promise<OAuthRedirect>
  }
  unlink(input: { sessionToken: SessionToken; identityId: string }): Promise<void>
}
interface PendingNamespace {
  resolve(token: PendingToken): Promise<PendingAuthentication | null>
  resolveFromHeaders(headers: Headers): Promise<PendingAuthentication | null>
  cancel(input: { pendingToken: PendingToken }): Promise<void>
}
```

`linkOAuth.start` has no `finish` of its own: the provider redirects back to exactly one callback
address, and `velve.oauth_flow` already knows from `link_to_user_id` whether a link is being made
or a sign-in performed; a second `finish` with identical input would be a branch that the client
would have to guess.

**The rule of the last sign-in method (L-13).** `unlink` fails with
`last_sign_in_method` when no sign-in method would be left afterwards. What is counted:
a `password_credential`, every WebAuthn credential, every further identity. A confirmed
email address does not count, although a magic link works with it, and recovery codes
do not count: they are a second factor, not a sign-in name. The same count protects
`webauthn.remove`. Alongside `account_disabled` this is the only visible error that gives
information about an account state; both are harmless, because they occur only within an existing
session and only about one's own account.

The intermediate state is not a session and is never found by `session.resolve`;
`pending.resolve` names only the factors available for choosing, no user data. `cancel` is
the cancel button; without it a half-finished attempt would remain valid for five minutes.

##### B.8 `auth.admin` does not exist

*First:* Velve Auth has no permission model (section 3.14). An
administration interface necessarily needs an answer to "who is allowed to do this", and the
library does not know the question; an `auth.admin` that accepts every caller is a
back door with a good name. *Second:* the surface already exists — disabling, enabling, deleting,
looking up is `auth.user.*`; a second version with a check bolted on would be duplication with
two truths. *Third:* ten of the 33 advisories of the comparison system are a missing
owner binding (section 5.10); an endpoint that accepts every caller is that
class in its purest form.

##### B.9 Preconditions per method

**Caller:** `—` none, `session` session token, `pending` token of the intermediate state,
`server` only in the process of the application. **Fresh:** the session must have been
created within `freshnessWindow`. `invalid_input` and `rate_limited` are possible everywhere,
`account_disabled` on every method with caller `session` (L-4); all three are omitted from
the error column.

| Method(s) | Caller | Fresh | Limit | Errors |
|---|---|---|---|---|
| `signUp.withPassword` | — | — | IP+account | `password_unacceptable`, `username_taken`, `username_invalid` |
| `signUp.withoutPassword` | — | — | IP+account | `username_taken`, `username_invalid` |
| `signIn.password` | — | — | IP+account | `invalid_credentials` (includes deactivation, L-4) |
| `signIn.passkey.start`, `signIn.oauth.start` | — | — | IP | `provider_not_configured` (oauth only) |
| `signIn.passkey.finish` | — | — | IP | `webauthn_challenge_invalid`, `webauthn_credential_rejected` |
| `signIn.oauth.finish` | — | — | IP | `oauth_flow_invalid`, `oauth_provider_error`, `identity_already_linked` |
| `signIn.magicLink.request` | — | — | IP+account | — |
| `signIn.magicLink.redeem` | — | — | IP | `invalid_token` |
| `signOut`, `session.refresh`, `pending.cancel` | session/pending | — | IP | `session_required` (`refresh` only) |
| `session.resolve`, `resolveFromHeaders`, `pending.resolve`, `pending.resolveFromHeaders` | — | — | **no** | — (return `null`; `session.*` throws `account_disabled`, L-4) |
| `session.list`, `revoke`, `revokeAllOther`, `revokeAll` | session | **yes** | IP | `session_required`, `freshness_required` |
| `user.findById`, `findByEmail`, `findByUsername`, `disable`, `enable`, `delete`, `maintenance.sweep` | server | — | **no** | — |
| `password.set` | session | **yes** | IP+account | `session_required`, `freshness_required`, `password_unacceptable`, `factor_already_enrolled` |
| `password.change` | session | **yes** | IP+account | `session_required`, `freshness_required`, `invalid_credentials`, `password_unacceptable` |
| `password.requestReset`, `email.requestVerification` | —/session | — | IP+account | `session_required` (`requestVerification` only) |
| `password.redeemReset` | — | — | IP | `invalid_token`, `password_unacceptable` |
| `password.redeemResetWithRecoveryCode` | — | — | IP+account | `invalid_recovery_code`, `password_unacceptable` |
| `email.redeemVerification`, `email.redeemChange` | — | — | IP | `invalid_token` |
| `email.requestChange` | session | **yes** | IP+account | `session_required`, `freshness_required` |
| `username.isAvailable` | — | — | IP (tight) | — |
| `username.change` | session | **yes** | IP+account | `session_required`, `freshness_required`, `username_taken`, `username_invalid` |
| `factor.totp.enroll.start` | session | **yes** | IP | `session_required`, `freshness_required`, `factor_already_enrolled` |
| `factor.totp.enroll.finish`, `factor.totp.remove` | session | **yes** | IP+account | `session_required`, `freshness_required`, `invalid_factor_code`, `factor_not_enrolled` |
| `factor.totp.verify` | pending | — | IP+account | `invalid_pending_authentication`, `invalid_factor_code`, `too_many_factor_attempts` |
| `factor.webauthn.register.start` | session | **yes** | IP | `session_required`, `freshness_required` |
| `factor.webauthn.register.finish` | session | **yes** | IP | `session_required`, `freshness_required`, `webauthn_challenge_invalid`, `webauthn_credential_rejected` |
| `factor.webauthn.authenticate.start` | pending | — | IP | `invalid_pending_authentication`, `factor_not_enrolled` |
| `factor.webauthn.authenticate.finish` | pending | — | IP+account | `invalid_pending_authentication`, `webauthn_challenge_invalid`, `webauthn_credential_rejected`, `too_many_factor_attempts` |
| `factor.webauthn.list`, `rename`, `factor.recovery.remaining`, `identity.list` | session | — | IP | `session_required` |
| `factor.webauthn.remove`, `identity.unlink` | session | **yes** | IP | `session_required`, `freshness_required`, `last_sign_in_method` |
| `factor.recovery.generate` | session | **yes** | IP | `session_required`, `freshness_required` |
| `factor.recovery.verify` | pending | — | IP+account | `invalid_pending_authentication`, `invalid_recovery_code`, `too_many_factor_attempts` |
| `identity.linkOAuth.start` | session | **yes** | IP | `session_required`, `freshness_required`, `provider_not_configured` |

`session.resolve` and `pending.resolve` are not rate limited: they run on every request
of the application, a counter on them would be a self-blockade.

---

#### C) Return types

```ts
type SessionToken = string & { readonly __brand: "SessionToken" }
type PendingToken = string & { readonly __brand: "PendingToken" }
type AuthenticationFactor = "password" | "totp" | "webauthn" | "recovery" | "oauth"

interface User {
  id: string; createdAt: Date; updatedAt: Date
  email: string | null; emailVerifiedAt: Date | null
  username: string | null                 // display form, NFKC
  disabledAt: Date | null; hasPassword: boolean
  importedFrom: "supabase" | "clerk" | "auth0" | "firebase" | "nextauth" | null
}
interface Session {
  id: string; userId: string
  createdAt: Date; lastUsedAt: Date; idleExpiresAt: Date; absoluteExpiresAt: Date
  factors: readonly AuthenticationFactor[]
  ipAddress: string | null; userAgent: string | null
  isCurrent: boolean                      // set only in session.list
}
interface Identity {
  id: string; provider: string; subject: string; createdAt: Date
  providerEmail: string | null; providerEmailVerified: boolean
  profile: unknown                        // raw claims; the library does not read them
  scopes: readonly string[]; tokenExpiresAt: Date | null
}
interface WebAuthnCredential {
  id: string; label: string; transports: readonly string[]; aaguid: string | null
  isBackupEligible: boolean               // true => synchronised passkey
  isCurrentlyBackedUp: boolean; wasUserVerifiedAtRegistration: boolean
  createdAt: Date; lastUsedAt: Date | null
}
interface PendingAuthentication {
  factorsCompleted: readonly AuthenticationFactor[]
  availableFactors: readonly ("totp" | "webauthn" | "recovery")[]
  attemptsRemaining: number; expiresAt: Date
}
interface OAuthRedirect { authorizationUrl: string; stateCookie: CookieInstruction }
interface CookieInstruction { name: string; value: string; maximumAgeInSeconds: number
                              attributes: "HttpOnly; Secure; SameSite=Lax; Path=/" }
interface PasskeyAuthenticationChallenge  { publicKeyOptions: PublicKeyCredentialRequestOptionsJSON;  challengeToken: string }
interface WebAuthnAuthenticationChallenge { publicKeyOptions: PublicKeyCredentialRequestOptionsJSON;  challengeToken: string }
interface WebAuthnRegistrationChallenge   { publicKeyOptions: PublicKeyCredentialCreationOptionsJSON; challengeToken: string }

// JSON forms of the WebAuthn specification, as @simplewebauthn/server defines them
type AuthenticatorAttestation = import("@simplewebauthn/server").RegistrationResponseJSON
type AuthenticatorAssertion   = import("@simplewebauthn/server").AuthenticationResponseJSON
type PublicKeyCredentialCreationOptionsJSON = import("@simplewebauthn/server").PublicKeyCredentialCreationOptionsJSON
type PublicKeyCredentialRequestOptionsJSON  = import("@simplewebauthn/server").PublicKeyCredentialRequestOptionsJSON
```

`username_key` does not appear: it is the comparison form. `hasPassword` is derived from the
existence of the row in `password_credential` and replaces a method `password.isSet`.
`Identity.profile` is `unknown`, because the library does not read these claims and may not promise a
structure that the provider changes tomorrow. `isBackupEligible`/
`isCurrentlyBackedUp` are spelled out instead of `be`/`bs` — they are the only basis
on which an application distinguishes device-bound from synchronised passkeys.
`CookieInstruction` is the only place at which server methods mention cookies.

##### C.1 `SignInResult`

```ts
type SignInResult =
  | { status: "signed_in"
      sessionToken: SessionToken
      session: Session
      user: User
      signCountRegressed?: boolean }         // only on WebAuthn paths
  | { status: "second_factor_required"
      pendingToken: PendingToken
      pending: PendingAuthentication }

type OAuthCallbackResult =
  | SignInResult
  | { status: "identity_linked"; identity: Identity; sessionToken: SessionToken; session: Session }
```

In the `second_factor_required` branch there is **no** `Session` and **no** `sessionToken` —
not as `null`, not as an optional field, but as an absent property. Whoever
reads `result.sessionToken` without a prior check of `result.status` does not compile.

*Design A* would have been a flat object `{ session: Session | null; pending: … | null }`:
shorter — and the shape that the comparison system has: there the password handler creates
the session, the 2FA hook deletes it again afterwards and sets `newSession` to `null`, with the
note that downstream hooks have to check the field
(`packages/better-auth/src/plugins/two-factor/index.ts:525-535`). A `session` field that is
sometimes set will at some point be read unchecked by some code path. *Design B*
is the discriminated union. **Decision: B.** The cost is one `if` per call site; the
benefit is that the library's most dangerous confusion does not compile.
`signCountRegressed` is optional, because the question is not asked on password sign-in —
`undefined` means "not applicable", not "no". In the linking case the session is issued
anew, because a new identity changes the trust level.

##### C.2 What never goes outside

`token_sha256` (`session`, `one_time_token`, `pending_authentication`) — the hash is the
verifier. `phc` and `scheme` (`password_credential`) — offline attack, and `scheme` reveals the
system of origin. `secret_enc`, `key_version` (`totp_credential`) — the ciphertext is, in the
plaintext case, the factor. `code_hmac` (`recovery_code`) — allows offline checking of guessed
codes against the pepper. `challenge_sha256` (`webauthn_challenge`) — allows replay.
`pkce_verifier_enc`, `state_sha256`, `nonce` (`oauth_flow`) — the verifier breaks PKCE.
`access_token_enc`, `refresh_token_enc`, `id_token_enc` (`identity`) — foreign tokens, only via
a separate call, never as a field of `Identity`. `credential_id`, `public_key`,
`sign_count` (`webauthn_credential`) — `credential_id` is a cross-device
recognition value, `sign_count` appears only as `signCountRegressed`. `tokens`,
`bucket_key` (`rate_bucket`) — reveals counter states of foreign accounts.

The rule behind it is machine-checkable: **no type of the public surface contains a
field of type `Uint8Array` or `Buffer`** — every `bytea` column is a verifier, a
ciphertext or a key. A type test in the test run enforces it.

---

#### D) The HTTP surface

##### D.1 `defineRoute` — one declaration, three products

```ts
type HttpMethod = "GET" | "POST"
type CallerRequirement    = "anonymous" | "session" | "pending" | "server_only"
type FreshnessRequirement = "not_required" | "required"
type OriginRequirement    = "checked" | "exempt"
interface RateLimitRule { perIpAddress: BucketRule | "none"; perAccount: BucketRule | "none" }
interface Validator<T>  { parse(raw: unknown): T }   // throws VelveError("invalid_input")
interface RequestContext {
  readonly session: Session | null                   // set for caller "session"
  readonly pending: PendingAuthentication | null     // set for caller "pending"
  readonly ipAddress: string | null; readonly userAgent: string | null
  readonly plugin: FrozenContext                     // Part G; for core routes without ownTables
}
declare function toWebHandler(auth: VelveAuth<IdentityMode>): (request: Request) => Promise<Response>

interface RouteDefinition<Name extends string, Path extends string, Input, Output,
                          Code extends VelveErrorCode> {
  readonly name: Name                    // dotted path, e.g. "signIn.password"
  readonly method: HttpMethod; readonly path: Path
  readonly input: Validator<Input>; readonly errors: readonly Code[]
  readonly caller: CallerRequirement; readonly freshness: FreshnessRequirement
  readonly originCheck: OriginRequirement; readonly rateLimit: RateLimitRule
  readonly handler: (input: Input, context: RequestContext) => Promise<Output>
}
type AnyRoute = RouteDefinition<string, string, any, any, VelveErrorCode>

declare function defineRoute<Name extends string, Path extends string, Input, Output,
                             Code extends VelveErrorCode>(
  d: RouteDefinition<Name, Path, Input, Output, Code>
): RouteDefinition<Name, Path, Input, Output, Code>

type ServerMethodOf<R> = R extends RouteDefinition<any, any, infer I, infer O, any>
  ? (input: I) => Promise<O> : never
type ClientMethodOf<R> = R extends RouteDefinition<any, any, infer I, infer O, infer C>
  ? (input: I) => Promise<VelveResult<O, C>> : never

type Nest<Name extends string, Fn> =
  Name extends `${infer Head}.${infer Rest}` ? { [K in Head]: Nest<Rest, Fn> } : { [K in Name]: Fn }
type UnionToIntersection<U> =
  (U extends unknown ? (arg: U) => void : never) extends (arg: infer I) => void ? I : never

type ServerSurface<T extends readonly AnyRoute[]> =
  UnionToIntersection<{ [I in keyof T]: Nest<T[I]["name"], ServerMethodOf<T[I]>> }[number]>
type ClientSurface<T extends readonly AnyRoute[]> =
  UnionToIntersection<{ [I in keyof T]: Nest<T[I]["name"], ClientMethodOf<T[I]>> }[number]>
```

`errors` is mandatory. The handler may throw only the codes named there; a test run
checks that against the actual throw catalogue. That makes a route's error list a
contract instead of a comment — and the client can handle it exhaustively. `object`,
`string` and the remaining constructors for `Validator<T>` live in `core/http/`; they are
not a public interface, because input schemas occur only in route declarations.

##### D.2 Two examples

```ts
const signInPasswordRoute = defineRoute({
  name: "signIn.password",
  method: "POST",
  path: "/sign-in/password",
  input: object({ emailOrUsername: string(), password: string() }),
  errors: ["invalid_credentials", "invalid_input", "rate_limited"] as const,
  caller: "anonymous",
  freshness: "not_required",
  originCheck: "checked",
  rateLimit: { perIpAddress: { capacity: 10, refillPerSecond: 0.1 }, perAccount: { capacity: 5, refillPerSecond: 0.01 } },
  handler: async (input, context): Promise<SignInResult> => { /* … */ },
})

const webauthnRegisterStartRoute = defineRoute({
  name: "factor.webauthn.register.start",
  method: "POST",
  path: "/factor/webauthn/register/start",
  input: object({}),
  errors: ["session_required", "freshness_required"] as const,
  caller: "session",
  freshness: "required",
  originCheck: "checked",
  rateLimit: { perIpAddress: { capacity: 20, refillPerSecond: 0.5 }, perAccount: "none" },
  handler: async (_input, context): Promise<WebAuthnRegistrationChallenge> => { /* … */ },
})
```

From the first declaration arises (a) the **handler** for `POST /sign-in/password` with a fixed
order in front of it — origin check, rate limiting (the key contains `"signIn.password"`,
not the raw path: `//sign-in/password` and `/sign-in/password` are the same counter),
`input.parse`, caller resolution, handler; (b) the **server method**
`auth.signIn.password(input)` returning `Promise<SignInResult>`, whose object path `Nest`
produces from the dotted `name`; (c) the **client type** `client.signIn.password(input)` returning
`Promise<VelveResult<SignInResult, "invalid_credentials" | "invalid_input" |
"rate_limited">>` — narrowed to three codes, not to the whole union. `account_disabled`
is absent on purpose: at sign-in a disabled account cannot be told apart from a wrong
password (L-4).

The second declaration shows two peculiarities: the four-level `name` produces four levels,
and the input schema is empty, because the caller is identified through the cookie. The
server method nevertheless gets a `sessionToken` field, which the HTTP layer fills in from the
cookie; `caller: "session"` produces exactly this one difference between the signatures.

##### D.3 The route table

| Method | Path | Input | Output | Status | Limit | Origin |
|---|---|---|---|---|---|---|
| POST | `/sign-up` | `IdentityFields & { password }` | `SignUpResult` | 200, 400, 409 | IP+account | yes |
| POST | `/sign-up/passwordless` | `IdentityFields` | `SignUpResult` | 200, 400, 409 | IP+account | yes |
| POST | `/sign-in/password` | `SignInLookup & { password }` | `SignInResult` | 200, 400, 401 | IP+account | yes |
| POST | `/sign-in/passkey/start` | — | `PasskeyAuthenticationChallenge` | 200 | IP | yes |
| POST | `/sign-in/passkey/finish` | `{ challengeToken, response }` | `SignInResult` | 200, 400, 401 | IP | yes |
| POST | `/sign-in/oauth/start` | `{ provider, redirectPath? }` | `OAuthRedirect` | 200, 400 | IP | yes |
| GET | `/sign-in/oauth/callback/:provider` | Query `{ code, state, iss? }` | 302 | 302, 400, 409, 502 | IP | **no** |
| POST | `/sign-in/magic-link/request` | `{ email }` | — | 204, 400 | IP+account | yes |
| POST | `/sign-in/magic-link/redeem` | `{ token }` | `SignInResult` | 200, 400 | IP | yes |
| POST | `/sign-out` | — | — | 204 | IP | yes |
| GET | `/session` | — | `ResolvedSession \| null` | 200, 403 | no | yes |
| GET | `/session/list` | — | `Session[]` | 200, 401, 403 | IP | yes |
| POST | `/session/revoke` | `{ targetSessionId }` | — | 204, 400, 401, 403 | IP | yes |
| POST | `/session/revoke-others` | — | `{ revokedCount }` | 200, 401, 403 | IP | yes |
| POST | `/session/revoke-all` | — | `{ revokedCount }` | 200, 401, 403 | IP | yes |
| POST | `/session/refresh` | — | `ResolvedSession \| null` | 200, 401 | IP | yes |
| POST | `/password/set` | `{ newPassword }` | `SetPasswordResult` | 200, 400, 401, 403, 409 | IP+account | yes |
| POST | `/password/change` | `{ currentPassword, newPassword }` | `SetPasswordResult` | 200, 400, 401, 403 | IP+account | yes |
| POST | `/password/request-reset` | `{ email }` | — | 204, 400 | IP+account | yes |
| POST | `/password/redeem-reset` | `{ token, newPassword }` | `SetPasswordResult` | 200, 400 | IP | yes |
| POST | `/password/redeem-reset-with-recovery-code` | `SignInLookup & { recoveryCode, newPassword }` | `SetPasswordResult` | 200, 400, 401 | IP+account | yes |
| POST | `/email/request-verification` | — | — | 204, 401 | IP+account | yes |
| POST | `/email/redeem-verification` | `{ token }` | `{ user }` | 200, 400 | IP | yes |
| POST | `/email/request-change` | `{ newEmail }` | — | 204, 400, 401, 403 | IP+account | yes |
| POST | `/email/redeem-change` | `{ token }` | `{ user }` | 200, 400 | IP | yes |
| GET | `/username/available` | Query `{ username }` | `{ available, reason? }` | 200, 400 | IP (tight) | yes |
| POST | `/username/change` | `{ newUsername }` | `{ user }` | 200, 400, 401, 403, 409 | IP+account | yes |
| POST | `/factor/totp/enroll/start` | — | `TotpEnrollment` | 200, 401, 403, 409 | IP | yes |
| POST | `/factor/totp/enroll/finish` | `{ code }` | — | 204, 401, 403, 409 | IP+account | yes |
| POST | `/factor/totp/verify` | `{ code }` | `SignInResult` | 200, 401, 429 | IP+account | yes |
| POST | `/factor/totp/remove` | `{ code }` | — | 204, 401, 403, 409 | IP+account | yes |
| POST | `/factor/webauthn/register/start` | — | `WebAuthnRegistrationChallenge` | 200, 401, 403 | IP | yes |
| POST | `/factor/webauthn/register/finish` | `{ challengeToken, response, label }` | `{ credential }` | 200, 400, 401, 403 | IP | yes |
| POST | `/factor/webauthn/authenticate/start` | — | `WebAuthnAuthenticationChallenge` | 200, 401, 409 | IP | yes |
| POST | `/factor/webauthn/authenticate/finish` | `{ challengeToken, response }` | `SignInResult` | 200, 400, 401, 429 | IP+account | yes |
| GET | `/factor/webauthn/list` | — | `WebAuthnCredential[]` | 200, 401 | IP | yes |
| POST | `/factor/webauthn/rename` | `{ credentialId, label }` | `{ credential }` | 200, 400, 401 | IP | yes |
| POST | `/factor/webauthn/remove` | `{ credentialId }` | — | 204, 401, 403, 409 | IP | yes |
| POST | `/factor/recovery/generate` | — | `{ codes }` | 200, 401, 403 | IP | yes |
| POST | `/factor/recovery/verify` | `{ code }` | `SignInResult` | 200, 401, 429 | IP+account | yes |
| GET | `/factor/recovery/remaining` | — | `{ remainingCount }` | 200, 401 | IP | yes |
| GET | `/identity/list` | — | `Identity[]` | 200, 401 | IP | yes |
| POST | `/identity/link/start` | `{ provider, redirectPath? }` | `OAuthRedirect` | 200, 400, 401, 403 | IP | yes |
| POST | `/identity/unlink` | `{ identityId }` | — | 204, 400, 401, 403, 409 | IP | yes |
| GET | `/pending` | — | `PendingAuthentication \| null` | 200 | no | yes |
| POST | `/pending/cancel` | — | — | 204 | IP | yes |

Not listed, because possible everywhere: `429 rate_limited` on every route with a limit (the
three 429s shown are `too_many_factor_attempts`), `403 origin_not_allowed` on every
route with an origin check, `403 account_disabled` on every route with caller `session`
(L-4) and `500 internal_error`.

46 routes in mode `username_email`, 44 in `email` (without `/username/*`), 38 in `username`
(additionally without magic link, password reset by email and `/email/*`); the numbers hold with
`webauthn` configured, without it the nine `webauthn` and `passkey` routes are missing. The
table is filtered by mode and configuration when the instance is created; a route that does not
exist in the chosen mode does not answer with 403 but does not exist and yields 404. `auth.user.*` and
`auth.maintenance.*` have no routes (B.3). Every response carries `Cache-Control: no-store`
and `Vary: Cookie`, set by the handler (L-6).

The OAuth callback is the only route without an origin check: it is a redirect back from the
provider by GET and by construction has no `Origin` header; its protection is the
server-side `state` in `velve.oauth_flow`, whose pointer lies in the cookie. The four routes with
`caller: "pending"` are the ones from 3.6; only they read `__Host-velve_pending`, every other route
ignores it entirely, and the count can be read off the declaration type.

---

#### E) The client

```ts
declare function createVelveClient<Auth extends { routes: readonly AnyRoute[] }>(
  options: { baseURL: string; fetch?: typeof fetch }
): ClientSurface<Auth["routes"]>
```

```
defineRoute(…)                        one declaration, value and type at once
   └─ const routes = [ … ] as const   Value: the route table
          └─ typeof routes            Type:  readonly [Route1, Route2, …]
                 ├─ ServerSurface<typeof routes>   auth.signIn.password(…)
                 └─ ClientSurface<typeof routes>   client.signIn.password(…)
```

`typeof auth` carries `routes` as a preserved tuple type, because the table is declared
`as const`. `ClientSurface` runs with `Nest` over the `name` fields and puts at every leaf the
signature from `Input`, `Output` and `Code` of the same declaration.

**Without a runtime proxy:** the route table is a real array at runtime.
`createVelveClient` iterates it **once** at creation and builds an ordinary
nested object — it splits `name` at the dots and puts at every leaf a
function that reads `method` and `path` from **the same row**. No `Proxy`, no
path assembly from property names, no kebab-case transformation, no heuristic "body
present, so POST". A call that is not in the table does not exist in the object:
at compile time a type error, at runtime a `TypeError`. The price is that the client
imports the table as a value; `@velve/auth/client` delivers it without handler references, so that
no server core lands in the browser.

```ts
type VelveResult<Value, Code extends VelveErrorCode> =
  | { ok: true;  value: Value }
  | { ok: false; error: { code: Code; message: string; retryAfterSeconds?: number } }

declare function unwrap<V, C extends VelveErrorCode>(result: VelveResult<V, C>): V
class VelveTransportError extends Error { readonly cause: unknown }
```

*Draft A:* the client throws, like the server — symmetric. But a thrown error can be
forgotten, and in the browser every call is an operation whose message the user
must see; a forgotten `catch` is a surface that says nothing. *Draft B:* a
result object — the compiler forces the check of `ok` before `value` is readable, and
`error.code` is narrowed to the codes of **this** route, so that a `switch` is checked
exhaustively. **Decision: B for the client, throwing for the server; the asymmetry is intended** —
on the server the call sits in a request handler with a central error mapping, where a
`throw` carries the point of abort straight to the response; on the client every call site is a
form that has to present the error itself. Whoever wants the symmetry calls `unwrap(…)`.

The client **throws** only in two cases that can have no code: network errors and
responses that are not a Velve error envelope. Both are `VelveTransportError`, not
`VelveError` — "the server said no" against "the server did not answer".
`retryAfterSeconds` is present only with `rate_limited`.

---

#### F) Error types

```ts
type VelveErrorCode =
  | "invalid_input" | "origin_not_allowed" | "rate_limited"
  | "invalid_credentials" | "account_disabled"
  | "session_required" | "freshness_required"
  | "invalid_token" | "invalid_factor_code" | "invalid_recovery_code"
  | "invalid_pending_authentication" | "too_many_factor_attempts"
  | "password_unacceptable" | "username_taken" | "username_invalid"
  | "factor_not_enrolled" | "factor_already_enrolled" | "last_sign_in_method"
  | "identity_already_linked" | "provider_not_configured"
  | "oauth_flow_invalid" | "oauth_provider_error"
  | "webauthn_challenge_invalid" | "webauthn_credential_rejected"
  | "internal_error"

class VelveError extends Error {
  readonly code: VelveErrorCode
  readonly httpStatus: number
  readonly retryAfterSeconds?: number
}
```

25 codes, stable: a code disappears only at a major version jump, a new one arrives only with
a new route.

| Code | When | Status | Visible |
|---|---|---|---|
| `invalid_input` | Input schema rejected, field missing, format wrong | 400 | yes |
| `origin_not_allowed` | `Origin` missing or not in `origins` | 403 | yes |
| `rate_limited` | A bucket is empty | 429 | yes |
| `invalid_credentials` | Password check failed | 401 | yes, **merged** |
| `account_disabled` | `user.disabled_at` set, only when an existing session is resolved (L-4) | 403 | yes |
| `session_required` | No session cookie, or an invalid one | 401 | yes, **merged** |
| `freshness_required` | Session older than `freshnessWindow` | 403 | yes |
| `invalid_token` | One-time artefact not redeemable | 400 | yes, **merged** |
| `invalid_factor_code` | TOTP code wrong or reused | 401 | yes, **merged** |
| `invalid_recovery_code` | Recovery code not found | 401 | yes, **merged** |
| `invalid_pending_authentication` | Intermediate state missing, expired, consumed | 401 | yes, **merged** |
| `too_many_factor_attempts` | `pending_authentication.attempts` exceeded | 429 | yes |
| `password_unacceptable` | Below `minimumLength` or above `maximumLengthInBytes` | 400 | yes |
| `username_taken` | `username_key` already taken | 409 | yes, **necessary** |
| `username_invalid` | Characters, length or reservation violated | 400 | yes |
| `factor_not_enrolled` | Factor not enrolled for this operation | 409 | yes |
| `factor_already_enrolled` | Factor already present | 409 | yes |
| `last_sign_in_method` | Unlinking removed the last way to sign in | 409 | yes |
| `identity_already_linked` | `(provider, subject)` belongs to another account | 409 | yes |
| `provider_not_configured` | Provider not in `oauth.providers` | 400 | yes |
| `oauth_flow_invalid` | `state`, PKCE, `nonce` or `iss` do not match | 400 | yes, **merged** |
| `oauth_provider_error` | Provider answers faultily or not at all | 502 | yes |
| `webauthn_challenge_invalid` | Challenge unknown, expired, used for a foreign purpose | 400 | yes, **merged** |
| `webauthn_credential_rejected` | Signature, RP ID, origin or verification wrong | 401 | yes, **merged** |
| `internal_error` | Everything else | 500 | yes, without details |

##### F.1 The deliberately indistinguishable cases

"Merged" means: several inner causes, one outer code, the same message, the same
status, the same body. The mapping lies in exactly one place, `core/http/error-map.ts`;
the inner codes are only logged.

| Outer code | Inner causes |
|---|---|
| `invalid_credentials` | `user_not_found`, `password_mismatch`, `no_password_credential`, `legacy_scheme_rejected`, `user_disabled` |
| `session_required` | `cookie_absent`, `session_not_found`, `session_idle_expired`, `session_absolute_expired` |
| `invalid_token` | `token_not_found`, `token_expired`, `token_consumed`, `token_purpose_mismatch`, `email_taken_on_change`, `user_disabled` |
| `invalid_factor_code` | `totp_code_wrong`, `totp_step_replayed`, `totp_not_confirmed` |
| `invalid_recovery_code` | `recovery_code_not_found`, `recovery_codes_exhausted`, `recovery_codes_never_generated` |
| `invalid_pending_authentication` | `pending_not_found`, `pending_expired`, `pending_consumed`, `pending_cookie_absent` |
| `oauth_flow_invalid` | `state_not_found`, `state_expired`, `pkce_mismatch`, `nonce_mismatch`, `issuer_mismatch`, `id_token_signature_invalid`, `user_disabled` |
| `webauthn_challenge_invalid` | `challenge_not_found`, `challenge_expired`, `challenge_purpose_mismatch` |
| `webauthn_credential_rejected` | `credential_unknown`, `signature_invalid`, `rp_id_mismatch`, `origin_mismatch`, `user_not_verified`, `user_disabled` |

Six operations produce **no** error at all although something failed inside, because an
error would give away existence: `signUp.*` with an email already taken (200 as on success, plus mail
`sign_up_attempt_on_existing_account`), `password.requestReset` and `signIn.magicLink.request`
without a matching account (204; the send callback is called with `request_for_unknown_address`,
L-1), `email.requestChange` with a target address belonging to someone else (204),
`session.revoke` with a missing target session or one belonging to someone else (204) and `signOut` with an unknown
token (204). The only operation that deliberately gives away existence is
`username.isAvailable` — not an error but a return value (B.5).

---

#### G) Plugin types

```ts
interface VelvePlugin<Id extends string = string> {
  readonly id: Id; readonly dependsOn?: readonly string[]
  readonly migrations?: readonly PluginMigration<Id>[]
  readonly routes?: readonly PluginRoute<Id>[]
  readonly hooks?: PluginHooks
  readonly errorCodes?: readonly `${Id}.${string}`[]
  readonly rateLimitRules?: Readonly<Record<`${Id}.${string}`, RateLimitRule>>
}
interface PluginMigration<Id extends string> {
  readonly version: number; readonly name: string; readonly sql: string
  readonly createsTables: readonly `${Id}_${string}`[]
}
type PluginRoute<Id extends string> =
  RouteDefinition<`${Id}.${string}`, `/x/${Id}/${string}`, any, any, VelveErrorCode>

interface PluginHooks {
  beforeSignIn?:        (event: SignInEvent,          context: FrozenContext) => Promise<void>
  afterSignIn?:         (event: SignInCompletedEvent, context: FrozenContext) => Promise<void>
  beforeSessionCreate?: (event: SessionCreateEvent,   context: FrozenContext) => Promise<void>
  afterSessionCreate?:  (event: SessionCreatedEvent,  context: FrozenContext) => Promise<void>
  beforeUserCreate?:    (event: UserCreateEvent,      context: FrozenContext) => Promise<void>
  afterUserCreate?:     (event: UserCreatedEvent,     context: FrozenContext) => Promise<void>
  beforeSessionRevoke?: (event: SessionRevokeEvent,   context: FrozenContext) => Promise<void>
}

interface SignInEvent {
  readonly method: "password" | "passkey" | "oauth" | "magic_link"
  readonly userId: string | null           // null as long as not resolved
  readonly ipAddress: string | null; readonly userAgent: string | null
}
interface SignInCompletedEvent extends SignInEvent {
  readonly userId: string; readonly sessionId: string
  readonly factors: readonly AuthenticationFactor[]
  readonly signCountRegressed?: boolean
}
interface SessionCreateEvent  { readonly userId: string
                                readonly factors: readonly AuthenticationFactor[] }
interface SessionCreatedEvent extends SessionCreateEvent { readonly sessionId: string }
interface UserCreateEvent     { readonly email: string | null; readonly username: string | null }
interface UserCreatedEvent    extends UserCreateEvent { readonly userId: string }
interface SessionRevokeEvent  { readonly sessionId: string; readonly userId: string
                                readonly reason: RevokeReason }
type RevokeReason = "sign_out" | "revoked_by_user" | "password_changed"
  | "password_reset" | "identity_linked"

interface FrozenContext {
  readonly clock: Clock; readonly identityMode: IdentityMode; readonly schema: string
  readonly repositories: FrozenRepositories
  readonly ownTables: { query<Row>(sql: string, params: readonly unknown[]): Promise<Row[]> }
  log(level: "info" | "warn" | "error", message: string,
      fields?: Readonly<Record<string, unknown>>): void
}
interface FrozenRepositories {
  findUserById(input: { userId: string; actor: PluginActor }): Promise<User | null>
  listSessionsForUser(input: { userId: string; actor: PluginActor }): Promise<Session[]>
  revokeSession(input: { sessionId: string; reason: RevokeReason; actor: PluginActor }): Promise<void>
}
interface PluginActor { readonly pluginId: string; readonly reason: string }
```

The namespace constraint is a type, not a runtime check: `name` begins with `${Id}.`, `path`
with `/x/${Id}/`, every created table with `${Id}_`, every error code with `${Id}.`. A plugin
that wants to override a core route cannot satisfy the declaration type; the
runtime check at startup remains for plugins written in JavaScript, and a name conflict there is
a start error, not a warning. `dependsOn` is sorted topologically, a cycle is a
start error.

Seven hook points, exactly the ones from 3.11. The return is everywhere
`Promise<void>` — that is the type which expresses "listener with a veto": a hook can
**reject** by throwing, and **observe** by doing nothing; it cannot replace the
response, because it cannot return one. A return type `Promise<Event | void>` would have
opened exactly the door 3.11 closes. All event fields are `readonly`, and
no event contains a session token, a plaintext password or a hash.

`Object.freeze` freezes the context at runtime, `readonly` makes the attempt a type error
— both, because the one holds for TypeScript callers and the other for everyone else.
`FrozenRepositories` deliberately contains **no** writing methods on `velve.user`,
`password_credential`, `totp_credential` or `recovery_code`: a plugin that can write passwords or
factors is a co-owner of the core. Every method demands an `actor` with
`pluginId` and `reason`, both mandatory, both logged; `ownTables.query` is restricted to
tables with the prefix `<pluginId>_`. From the context no path leads to the
password verifier, to session resolution or to the origin check — they are not part of the
type. Hooks run without exception **after** the origin check and rate limiting, including for direct
server method calls.

##### G.1 Example: logging sign-ins

```ts
export function signInLogPlugin(): VelvePlugin<"sign_in_log"> {
  return {
    id: "sign_in_log",
    dependsOn: [],
    migrations: [{
      version: 1,
      name: "create_sign_in_log",
      createsTables: ["sign_in_log_entry"],
      sql: `CREATE TABLE sign_in_log_entry (
              id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              user_id uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
              method text NOT NULL, factors text[] NOT NULL,
              ip_address inet, user_agent text,
              occurred_at timestamptz NOT NULL DEFAULT now());
            CREATE INDEX sign_in_log_entry_user_idx
              ON sign_in_log_entry (user_id, occurred_at DESC);`,
    }],
    hooks: {
      afterSignIn: async (event, context) => {
        await context.ownTables.query(
          `INSERT INTO sign_in_log_entry (user_id, method, factors, ip_address, user_agent)
           VALUES ($1, $2, $3, $4, $5)`,
          [event.userId, event.method, event.factors, event.ipAddress, event.userAgent],
        )
      },
    },
    routes: [
      defineRoute({
        name: "sign_in_log.listOwn",
        path: "/x/sign_in_log/list-own",
        method: "GET",
        input: object({}),
        errors: ["session_required"] as const,
        caller: "session",
        freshness: "not_required",
        originCheck: "checked",
        rateLimit: { perIpAddress: { capacity: 30, refillPerSecond: 1 }, perAccount: "none" },
        handler: async (_input, requestContext) =>
          requestContext.plugin.ownTables.query<SignInLogEntry>(
            `SELECT id, method, factors, ip_address, user_agent, occurred_at
               FROM sign_in_log_entry WHERE user_id = $1
               ORDER BY occurred_at DESC LIMIT 50`,
            [requestContext.session.userId],
          ),
      }),
    ],
  }
}
```

The route inherits the entire derivation chain: `auth.sign_in_log.listOwn()` as a server method,
`client.sign_in_log.listOwn()` as a typed client call, `GET /x/sign_in_log/list-own` as an
HTTP route with an origin check and a rate counter in front of it. A table name without a prefix would be a
type error in `createsTables`, a path without `/x/sign_in_log/` one in `path`. The plugin
writes only into its own table and has no access to session tokens or passwords.

### 3.16 Decided gaps

Working out the interface (3.15) and the test plan (section 6) exposed thirteen places at which sections 3.1 to 3.14 were incomplete. They are decided here; the sections before them are aligned with that. These decisions are part of the specification, not an appendix.

**L-1 — No response deadline, but a waiting limit.**
It was considered to stretch every response in the sign-in path to a fixed minimum duration. Rejected. A deadline hides exactly the fault it is meant to prevent: if the checking path ever becomes non-uniform, it does not show as long as both branches stay below the threshold — and above the threshold it leaks again. Instead the harder rule holds: **every endpoint has exactly one code path, which performs the same work independently of the outcome.** For passwords that means one KDF call with identical parameters, against a dummy as well. For operations without a KDF — requesting a reset, requesting a verification — it means the same sequence of queries and in every case one call of the send callback; whether a welcome, a reset or a "no account exists here" message goes out is decided inside the callback. The proof is the statistical test from section 6, not a number in the configuration.

To be kept apart from that is the **waiting limit** of the semaphore from 3.3 (E-13): whoever has not got a place after **5 seconds** is rejected with `rate_limited`. That is a resource limit, not a time equalisation — it takes effect depending on load and equally for existing and non-existing accounts.

**L-2 — The PHC string is stored encrypted.**
A pepper in the classical sense cannot be implemented without breaking imported hashes: it would have to enter the derivation, and foreign hashes were created without it. The effect that is at issue — a stolen database dump alone is of no use — is achieved instead by **envelope encryption of the entire column**.

```sql
ALTER TABLE velve.password_credential
  ADD COLUMN phc_enc     bytea,
  ADD COLUMN key_version integer NOT NULL DEFAULT 1;
-- The migration runner encrypts every row into the new column before the old one
-- is dropped. A plain retyping would write plaintext bytes.
ALTER TABLE velve.password_credential
  DROP COLUMN phc,
  ALTER COLUMN phc_enc SET NOT NULL;
ALTER TABLE velve.password_credential RENAME COLUMN phc_enc TO phc;
```

`phc` holds AES-256-GCM over the canonical PHC string, key purpose `password-enc` (the sixth purpose in 3.8). `scheme` stays in the clear, so that the estate can be evaluated without decryption. This works equally for created **and** imported hashes, is rotatable, and the rotation runs on the same path as the rehash (3.3, step 6): after a successful sign-in, by compare-and-swap, silently.

The price is named: **loss of the key means loss of all passwords.** That is the same risk class as a pepper and belongs in first place in the operations documentation.

**L-3 — Recovery codes carry a key version.**
`velve.recovery_code` gets `key_version integer NOT NULL`. Without it a rotation of `token-pepper` would have invalidated every recovery code — in the configuration `username` therefore the only remaining way back into the account.

**L-4 — "Account disabled" is invisible at sign-in.**
A sign-in with the correct password on a disabled account gives the same answer as one with a wrong password. Otherwise the deactivation is an enumeration oracle, and a particularly valuable one at that. `account_disabled` appears exclusively when an existing session is resolved — there the caller has already proved that the account belongs to them.

**L-5 — The per-account counter is formed on the identifier, not on the account ID.**
The key is `HMAC(token-pepper, normalised_identifier)`. With that the limit takes effect **before** the user is resolved, existing and non-existing accounts run through the same row, and the identifier is not in the table in the clear. Exceeding it leads to a **rejection**, not to a delay: a delay would be a timing channel and would contradict the uniformity rule from L-1.

**L-6 — Every response carries `Cache-Control: no-store` and `Vary: Cookie`.**
Set by the handler, not by the application. A CDN in front, of which the library knows nothing, is the normal case and not the exception.

**L-7 — Password policy: minimum length 8, maximum length 4096 bytes, no composition rules.**
That follows NIST SP 800-63B. No forced rotation, no character classes, no password history in the core.
A comparison against leak corpora does **not** belong in the core: it needs network access (ESTIMATE: which Caprock possibly does not grant), and it is a policy decision. Instead there is exactly one hook point in `PasswordConfig` (3.15 A.4):

```ts
password.validate?: (plaintext: string) => Promise<void>
```

It is called on setting and on changing, **never at sign-in**. With that the plaintext password reaches no foreign code on the hot path, and whoever wants a compromise check hangs it in there.

**L-8 — At most five attempts per intermediate state.**
`pending_authentication.attempts` runs against 5. After that the row is deleted and the operation starts again from the password. No account locking.

**L-9 — A regressing `sign_count` is reported, not rejected.**
That is a deliberate deviation from WebAuthn Level 3 §7.2 and is documented. Synchronised passkeys do not keep the counter reliably; a rejection would lock out legitimate users. The finding reaches the application as the field `signCountRegressed` in the sign-in result, and the application decides there.

**L-10 — Session metadata is truncated by default.**
`sessionMetadata: "truncated" | "full" | "none"`, default `truncated`: IPv4 to `/24`, IPv6 to `/64` — for IPv6 the same prefix length as in the rate limiting under 3.9 —, user agent to browser and system family. That is data minimisation under Art. 5(1)(c) GDPR as a default value instead of as a configuration task. Whoever needs the full value switches it on explicitly.

**L-11 — Cleanup is a named operation, not a background timer.**
`auth.maintenance.sweep()` (3.15 B) deletes expired rows from `session`, `one_time_token`, `pending_authentication`, `webauthn_challenge`, `oauth_flow`, `totp_used_step` and `rate_bucket`. In addition the equivalent SQL is shipped through `@velve/auth/schema`, so that it can run from `pg_cron` or a schedule of one's own. No `setInterval` in the core — it survives no serverless execution and feigns operation where none takes place. Retention: `totp_used_step` two minutes beyond the window, `rate_bucket` one hour beyond expiry, everything else immediately.

**L-12 — A pre-created account loses its password when somebody else verifies the address.**
That is the gap with an immediate attack consequence, and it is the same one Better Auth failed at twice (CVE-2026-53516; GHSA-qq9h-g4jm-xgf3, open from 1.1.3 to 1.6.21).

The attack: an attacker registers `opfer@example.com` with a password that he knows. He cannot verify the address. Later the victim signs in through a magic link — thereby proving control over the mailbox, and the account counts as verified. The password set by the attacker, however, remains valid.

The rule: **if an email address is verified for the first time, and the existing password was set in a different session from the one that is verifying now, then the password sign-in is deleted and every existing session is revoked.** The rightful owner sets a password afterwards. Nothing is lost except an access that nobody ever proved.

**L-13 — The last way to sign in may not be removed.**
A user always keeps at least one of {password, WebAuthn credential, linked identity}. The attempt to remove the last one is rejected with `last_sign_in_method`. For second factors the same holds only if the configuration requires a second factor.

### 3.17 The resulting schema changes

Merged with the additions from the migration module (section 4), the following difference against the schema in 3.2 results. The shipped migration no. 1 creates all tables directly in their final form; the `ALTER` statements show the difference and are the path for a database that has already been filled in the form from 3.2.

```sql
-- L-2: the four statements from 3.16 (new column, re-encrypt, drop the old column,
-- rename). Result in velve.password_credential:
--   phc          bytea   NOT NULL             -- AES-256-GCM over the canonical PHC string
--   key_version  integer NOT NULL DEFAULT 1

-- L-3
ALTER TABLE velve.recovery_code
  ADD COLUMN key_version integer NOT NULL DEFAULT 1;

-- from section 4.0.3: idempotence of the import
CREATE TABLE velve.import_mapping (
  source      text NOT NULL,   -- 'supabase'|'clerk'|'auth0'|'firebase'|'nextauth'
  source_id   text NOT NULL,   -- source primary key, unchanged
  user_id     uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
  run_id      uuid NOT NULL,   -- which run created the row
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_id)
);
CREATE INDEX import_mapping_user_idx ON velve.import_mapping (user_id);
CREATE INDEX import_mapping_run_idx  ON velve.import_mapping (run_id);

-- from section 4.0.5: legacy hashes that cannot be verified
CREATE TABLE velve.password_reset_required (
  user_id    uuid PRIMARY KEY REFERENCES velve.user(id) ON DELETE CASCADE,
  reason     text NOT NULL,   -- 'unsupported_scheme'|'hash_not_exported'
                              -- |'missing_parameters'|'malformed'|'no_password_in_source'
  source     text NOT NULL,
  detail     text,            -- e.g. 'clerk:phpass', 'auth0:md5'
  created_at timestamptz NOT NULL DEFAULT now()
);
```

With that the schema comprises **sixteen tables**. For comparison: Better Auth manages with four in its core — `user`, `session`, `account`, `verification`, plus `rateLimit` only with database rate limiting (`packages/core/src/db/get-tables.ts:59-61`) — and distributes the rest across plugins. The difference is not bloat but explicitness — intermediate states, one-time artefacts and challenges which there sit in cookies, JWTs or the generic `verification` table have here a row of their own with a deadline of their own and a consumption of their own.

---

## 4. Migration module

The migration module lives in the subpath `@velve/auth/import` (section 3.1). Only there may heavy dependencies stand — CSV parsers, PGP decryption, source drivers. The core does not know the module; it knows only the result: rows in the `velve` schema and canonical PHC strings per section 3.3. The importer produces the PHC string but never writes it into `velve.password_credential.phc` itself: per L-2 (section 3.16) the column holds the AES-256-GCM-encrypted string under the key purpose `password-enc`, and for that the importer uses the same encryption path the core uses when registering; `key_version` is the current version of that key. The same holds for `velve.recovery_code.key_version` (L-3), should a project-specific hook supply recovery codes — none of the five sources does.

Basic attitude: a migration is not a script but a procedure with a pre-check, a dry run, repeatability and a loss report. Everything that does not come with it is named.

The same for all five sources, therefore carried in the individual sections only as a table row and not justified again: email addresses are trimmed, NFKC-normalised and lowercased, usernames separated into display and comparison form (section 3.4); `imported_from` and `imported_at` are set; active sessions, session tokens and one-time artefacts of the source are discarded, because sections 3.5 and 3.7 issue their own — every migration forces all users to sign in again.

---

### 4.0 Design of the migration module

#### 4.0.1 The interface

An importer is four things: a pre-check, a reader, a pure mapping, a proof. The mapping is deliberately **pure** — no I/O, no randomness. Only that way does the dry run execute the same code as the write run.

```ts
type SourceName = 'supabase' | 'clerk' | 'auth0' | 'firebase' | 'nextauth'
type Scheme = 'argon2id' | 'argon2i' | 'argon2d' | 'bcrypt' | 'scrypt'
            | 'pbkdf2-sha256' | 'pbkdf2-sha512' | 'fbscrypt'

type PasswordOutcome =
  | { readonly kind: 'none' }                                    // source has none
  | { readonly kind: 'phc'; readonly phc: string; readonly scheme: Scheme }
  | { readonly kind: 'unusable'; readonly sourceScheme: string
      readonly reason: 'unsupported_scheme' | 'hash_not_exported'
                     | 'missing_parameters' | 'malformed' | 'no_password_in_source' }

/** The only data type the writer knows. Source-neutral. */
interface VelveRecord {
  readonly sourceId: string                    // key for idempotence (section 4.0.3)
  readonly user: {
    readonly id?: string                       // only if the source ID is a UUID (section 4.0.7)
    readonly email: string | null              // already trim + NFKC + lower
    readonly emailVerifiedAt: Date | null
    readonly username: string | null           // display form (NFKC)
    readonly usernameKey: string | null        // NFKC + casefold
    readonly disabledAt: Date | null
    readonly createdAt: Date | null; readonly updatedAt: Date | null
  }
  readonly password: PasswordOutcome
  readonly identities: ReadonlyArray<{
    readonly provider: string                  // Velve provider name, not the source name
    readonly subject: string                   // stable provider ID, never the email
    readonly providerEmail: string | null
    readonly providerEmailVerified: boolean
    readonly profile: unknown | null           // raw claims
    readonly scopes: readonly string[] | null
    readonly tokens: { access?: string; refresh?: string; id?: string; expiresAt?: Date } | null
  }>
  readonly totp: { secret: string; confirmedAt: Date | null } | null   // Base32 plaintext
  readonly recoveryCodes: readonly string[] | null                     // plaintext
  readonly webauthn: ReadonlyArray<{
    readonly credentialId: Uint8Array; readonly publicKey: Uint8Array
    readonly signCount: bigint; readonly transports: readonly string[] | null
    readonly aaguid: string | null
    readonly backupEligible: boolean; readonly backupState: boolean
    readonly userVerifiedAtRegistration: boolean; readonly label: string | null
  }>
  readonly warnings: readonly Warning[]
}

interface Importer<Config, Raw> {
  readonly source: SourceName
  /** Check connection/file, report schema drift and missing required parameters. Never writes. */
  probe(config: Config): Promise<{ reachable: boolean; estimatedRecords: number | null
                                   missingRequiredConfig: readonly string[]
                                   schemaWarnings: readonly string[] }>
  /** Streams the source; abortable and resumable from a cursor. */
  read(config: Config, from?: Cursor): AsyncIterable<Raw>
  /** Pure. No I/O. Deterministic. */
  map(record: Raw): VelveRecord | MappingError
  /** The proof: a record with a known password is checked against the produced
   *  PHC string. Without a passed verify() there is no write run. */
  verify(config: Config, sample: { sourceId: string; plaintextPassword: string }):
    Promise<{ ok: true; scheme: Scheme } | { ok: false; reason: string }>
}
```

`read` is in the interface over and above what was stipulated: without a streaming reader no population of millions can be processed, and the separation "reader delivers `Raw`, mapper is pure" is the precondition for a meaningful dry run. `verify()` is the answer to a documented failure mode: with Firebase, `rounds` and `mem_cost` are easy to mix up, and a swapped pair produces **no error**, only hashes that never match (findings report `findings/05-migrationsquellen.md`, sections 4.3 and 8). Otherwise the error only becomes visible after the switchover. The PHC string from `map()` is plaintext in the importer's memory; the encryption per L-2 happens only in the writer, at the same place as in the core.

#### 4.0.2 Dry run, mandatory

`plan()` runs without write access; the driver is wrapped in a wrapper that rejects everything but `SELECT`. The result is a report:

```ts
interface DryRunReport {
  source: SourceName; readAt: Date
  records:   { total: number; mapped: number; rejected: number }
  passwords: { byScheme: Record<Scheme, number>          // what lands verifiably
               unusableByReason: Record<string, number>  // reset path, section 4.0.5
               none: number }                            // OAuth-only, phone-only, anonymous
  collisions: { emailWithinSource:        Array<{ email: string; sourceIds: string[] }>
                emailAgainstExisting:     Array<{ email: string; sourceId: string; userId: string }>
                usernameKeyWithinSource:  Array<{ usernameKey: string; sourceIds: string[] }>
                usernameKeyAgainstExisting: Array<{ usernameKey: string; sourceId: string }>
                subjectAlreadyLinked:     Array<{ provider: string; subject: string }> }
  identityConstraint: { configured: 'email'|'username'|'username_email'; violating: number }
  usernamePolicy: { rejectedByAllowlist: number }
  factors:    { totp: number; totpDropped: number; recoveryCodes: number
                webauthn: number; webauthnDroppedNoFlags: number }
  identities: { total: number; byProvider: Record<string, number>; withTokens: number }
  unrecoverable: number    // no password, no email, no recovery codes
}
```

Three numbers refuse the write run as long as they are not explicitly acknowledged: `collisions.emailWithinSource` (section 4.0.6), `identityConstraint.violating` (the chosen configuration from section 3.4 does not fit the existing population — for instance `identity: "email"` with anonymous Supabase users without an email) and `unrecoverable` (users without any way back into the account). The report is written as JSON and as a plaintext table; it is the basis of the user communication before the switchover, not merely a log.

#### 4.0.3 Idempotence

**Decision: a mapping table `velve.import_mapping` **plus** `ON CONFLICT DO NOTHING` on every target table. Both, not one of the two.**

`imported_from` alone is not enough: the column holds only a source name (section 3.2), no source ID; a second run could not decide whether *this* record is already there. Nor can the source ID simply become `velve.user.id`, because in three of five sources it is not a UUID — Clerk `user_2abc…`, Auth0 `auth0|abc123`, Firebase `OzDdXA7LwoR7lX2MH7AXaEmmn5u2`. And `ON CONFLICT DO NOTHING` alone is likewise not enough: the natural conflict would be the email, which in section 3.2 is nullable and unique only through a partial unique index — for users without an email there is no conflict at all, and a second run duplicates them.

The table — primary key `(source, source_id)`, `user_id` with `ON DELETE CASCADE`, `run_id` per run, indexes on `user_id` and `run_id` — stands as DDL in section 3.17.

Why in the core schema and not in a plugin table: it is versioned by the core schema runner (`velve.schema_migration`), it references `velve.user(id)` with `ON DELETE CASCADE`, and it survives the import — it is the only place where it remains answerable later which Velve user corresponds to which source ID (follow-up runs, support queries, re-pointing application foreign keys). A plugin prefix `<plugin-id>_` (section 3.11) would be wrong, because no plugin is involved.

| Table | Conflict target | Behaviour | Why |
|---|---|---|---|
| `velve.import_mapping` | `(source, source_id)` PK | `DO NOTHING` | re-entry after an abort |
| `velve.password_credential` | `(user_id)` PK | `DO NOTHING` | A password that the user has changed or that the rehash (section 3.3, step 6) has replaced may **never** be overwritten by a second run. What is written is `phc` encrypted under `password-enc` and `key_version` (L-2) |
| `velve.identity` | `(provider, subject)` | `DO NOTHING` | linking rule section 3.10 |
| `velve.totp_credential` | `(user_id)` PK | `DO NOTHING` | a newly set up factor wins against the imported one |
| `velve.recovery_code` | `(user_id, code_hmac)` PK | `DO NOTHING` | idempotent of itself; `key_version` = current version of `token-pepper` (L-3) |
| `velve.webauthn_credential` | `(credential_id)` | `DO NOTHING` | credential ID is globally unique |

`DO NOTHING` instead of `DO UPDATE` is the decision everywhere: an import is an **initial population**, not a synchronisation. After the switchover the source may not overwrite anything that has happened in Velve Auth.

#### 4.0.4 Transaction boundaries and batch size

Two passes. **Pass 1** writes `velve.user` + `velve.import_mapping` — necessarily in the *same* transaction, otherwise after an abort there are users without a mapping and the repeat run duplicates them. **Pass 2** writes `password_credential`, `identity`, `totp_credential`, `recovery_code`, `webauthn_credential` and resolves source IDs through the mapping table; it is repeatable on its own, which allows individual aspects to be caught up (Auth0 hashes delivered later) without recreating the users.

**Batch size 1000 records per transaction** (ESTIMATE: optimum 500–5000 depending on network latency; configurable). A batch is a multi-row `INSERT` via `unnest` — one round trip, one plan:

```sql
INSERT INTO velve.user (id, email, email_verified_at, username, username_key,
                        disabled_at, imported_from, imported_at, created_at)
SELECT * FROM unnest($1::uuid[], $2::text[], $3::timestamptz[], $4::text[], $5::text[],
                     $6::timestamptz[], $7::text[], $8::timestamptz[], $9::timestamptz[])
ON CONFLICT DO NOTHING RETURNING id;
```

No single large transaction over millions of rows, for four reasons: no resumption after an abort (an error at record 900,000 throws everything away); the snapshot blocks `VACUUM` for the entire runtime; WAL, locks and replication lag grow without bound; `idle_in_transaction_session_timeout` and connection poolers in transaction mode (on Supabase the normal case) terminate long transactions. Instead the runner remembers the cursor of the source ordering (`created_at, id`; with Auth.js, whose reference schemas carry no `createdAt`, only `id`) and resumes there; the mapping table catches the overlap.

Pass 2 does not write `password_credential` via `unnest` with a plaintext PHC, but through the same repository method that registration also uses: it encrypts the PHC string under `password-enc` and sets `key_version` (L-2). The importer has no write path of its own into this column.

**Indexes stay in place.** Dropping and recreating the partial unique indexes on `email` and `username_key` would be faster, but would switch off exactly the protection the import needs: collisions are meant to surface *during* the run. And: if a batch returns fewer rows than it inserted, `DO NOTHING` has struck — the runner then queries the difference specifically and writes every lost source ID with a reason into the report. A `DO NOTHING` that nobody counts is a data loss without a witness.

ESTIMATE: 1 million users, batches of 1000, 15–40 ms per transaction give 15–40 s of pure write time for pass 1. The bottleneck in all five cases is the source side — Auth0's rate limiting, Clerk's pagination, Firebase's file size — not PostgreSQL.

#### 4.0.5 Handling hashes that are not verifiable

Three kinds of user have no usable hash: those without a password in the source (OAuth-only, phone-only, anonymous, `is_sso_user`), those whose hash is not handed out (Auth0 on the free tier), and those with a scheme that Velve Auth does not take into the switch from section 3.3 (md5, sha1, phpass …). For all three: **no row is written in `velve.password_credential`.** A placeholder PHC would be a wrong value in the canonical field and would force a new prefix line in the switch.

Instead the user is marked in `velve.password_reset_required` — one row per user with `reason` (`unsupported_scheme`, `hash_not_exported`, `missing_parameters`, `malformed`, `no_password_in_source`), `source` and `detail`; the DDL stands in section 3.17.

The sign-in path, without a new enumeration channel: (1) check the input length (section 3.3, step 1). (2) Resolve the user; no `password_credential` found → **the same code path as with an unknown user**, that is, a check against the dummy PHC with the configured default parameters (section 3.3, step 2): same computation time, same memory, same semaphore. (3) The answer is the uniform error response from section 3.13 — same status, same headers, same body; **no field, no error code and no timing difference reveals the marking**. (4) *After* sending the response, in the same bounded background task that also carries the rehash (section 3.3, step 6): if a row exists in `password_reset_required` and the user has a confirmed email, a `one_time_token` with `purpose = 'password_reset'` is produced (1 h, section 3.7) and the reset mail sent, with a text that explains the migration. (5) At most one such mail per user and hour, through the same token bucket as the regular reset (section 3.9). (6) If the user sets the password, the same transaction deletes the marking and writes `password_credential`.

That is exactly the pattern from section 3.13: *"The difference moves exclusively into the email that is sent."* The attacker sees nothing; the account holder gets the way back without ever seeing an error he does not understand. In the `username` configuration (section 3.4) there is no email path — there the recovery code is the only way, and if that is missing too, the account is lost. Exactly these cases are what the dry run counts as `unrecoverable`.

#### 4.0.6 Collision resolution

**Decision: two source accounts with the same email are never merged automatically; the default is to abort before the write run.** Four reasons, by weight:

1. **The email is not proof of identity.** Section 3.10 makes that non-negotiable for provider linking: `(provider, subject)` is the only key, never the email. To break exactly this rule in the import would be absurd — and it is the same mistake that earned Better Auth CVE-2026-53516 (CVSS 8.3).
2. **A merge gives away a password.** `password_credential` has `user_id` as its primary key: of two hashes one survives. The owner of the discarded password can no longer get in — but the other one can, into an account that now carries the identities and factors of both. That is a privilege escalation through migration.
3. **It is demonstrably not an edge case.** Auth0 allows the same email across connections; with 125,000 migrated Auth0 users there were "a few thousand cases of multiple user accounts with the same email address", of which around 100 were not automatically resolvable (<https://kevcodez.medium.com/migrating-125-000-users-from-auth0-to-supabase-81c0568de307>), plus "falsely matched user accounts" from Auth0 account linking (ibid.).
4. **Otherwise the ordering decides.** The partial unique index `user_email_key` lets the first row through and throws the second away — the order of the source file determines the winner.

| Policy | Behaviour |
|---|---|
| `abort` (default) | dry run lists all collisions, write run refuses |
| `manual` | mapping file `source_id,action` with `action ∈ {import, skip, email:<new>}`; only fully resolved collisions are written |
| `skip-duplicates` | oldest `created_at` wins, all further ones are reported by name and skipped. Not the default, because of silent loss of access |

For usernames the same rule holds with an additional trap: `username_key` is NFKC + casefold (section 3.4), so names that differ in the source (`Müller`/`MÜLLER`) collapse into one key — counted separately as `usernameKeyWithinSource`. Counted separately as well is how many names fail the default allowlist `[a-z0-9_-]`, 3–32 characters: Auth0 allows up to 128 characters, Clerk and Auth.js know dots and umlauts. The allowlist is configurable and must be set **before** the import to a superset of the existing population. Collisions on `(provider, subject)` are the harmless case: the constraint catches them, `DO NOTHING` leaves the existing entry standing, the report counts it.

#### 4.0.7 UUID preservation

**Rule `preserveIds: 'auto'`:** the source ID becomes `velve.user.id` if it is a valid UUID and still free; otherwise a new one is produced and the source ID lives on in `velve.import_mapping`.

| Source | ID form | Carry-over |
|---|---|---|
| Supabase | `uuid` | **mandatory** |
| Auth.js (Drizzle) | `text`, default `crypto.randomUUID()` | yes, if all values are UUIDs |
| Auth.js (Prisma) | `cuid` (25 characters) | no |
| Clerk | `user_2abc…` | no |
| Auth0 | `auth0\|abc123` | no |
| Firebase | `OzDdXA7LwoR7lX2MH7AXaEmmn5u2` | no |

With **Supabase, preservation is not optional**: in almost every project, tables in the `public` schema reference `auth.users(id)` by foreign key, and RLS policies compare against `auth.uid()` — exactly this pattern is what the documentation recommends (<https://supabase.com/docs/guides/auth/managing-user-data>). New IDs mean broken foreign keys and policies that no longer fit anybody; the Supabase importer therefore refuses `preserveIds: false`. With the remaining four the source ID stays valuable for application data that still points at it — for that, `import_mapping` is the right place and not an `external_id` column on `velve.user`: section 3.14 says explicitly that no profile data lies there, and such a column would be the beginning of exactly that.

---

### 4.1 Supabase (GoTrue)

#### a) Obtaining the data

The simplest case: the auth data lie in the same PostgreSQL to which the customer has full access anyway (<https://github.com/orgs/supabase/discussions/3897>).

1. Connection string: Dashboard → *Project Settings → Database* — the **direct** connection, not the pooler on port 6543 (transaction mode does not tolerate long cursors).
2. Check the population: `psql "$SUPABASE_URL" -c "SELECT count(*) FROM auth.users WHERE deleted_at IS NULL;"`
3. Read — **column by column, explicitly**, never `SELECT *`. The documentation warns: "Columns, indices, constraints or other database objects managed by Supabase may change at any time." (<https://supabase.com/docs/guides/auth/managing-user-data>)
   ```
   psql "$SUPABASE_URL" -c "\copy (
     SELECT u.id, u.email, u.encrypted_password, u.email_confirmed_at, u.phone,
            u.raw_app_meta_data, u.raw_user_meta_data, u.banned_until, u.deleted_at,
            u.is_sso_user, u.is_anonymous, u.created_at, u.updated_at
     FROM auth.users u ORDER BY u.created_at, u.id) TO 'users.csv' WITH (FORMAT csv, HEADER)"
   ```
   analogously for `auth.identities` and `auth.mfa_factors`. The importer's default route is a second `pg` pool without an intermediate file.
4. `pg_dump --schema=auth --data-only` works too, but can fail on the ownership of Supabase-internal objects (Discussion #3897, Issue #1856).

**Not viable:** `GET /admin/users` does not deliver `encrypted_password` — the field is marked `json:"-"` in the Go struct (<https://raw.githubusercontent.com/supabase/auth/master/internal/models/user.go>); the `auth` schema is not exposed through the generated REST API either. **Duration:** ESTIMATE: minutes to hours, purely dependent on the population. No ticket, no approval.

#### b) Source schema

`auth.users` (<https://raw.githubusercontent.com/supabase/auth/master/internal/models/user.go>), `auth.identities` (<https://raw.githubusercontent.com/supabase/auth/master/internal/models/identity.go>), `auth.mfa_factors` (<https://raw.githubusercontent.com/supabase/auth/master/internal/models/factor.go>). PG types `ESTIMATE:` where derived from the Go type.

| Field | Type | Meaning |
|---|---|---|
| `users.id` | `uuid` PK | user ID; referenced by foreign keys and RLS |
| `users.email` | `varchar` | email, can be NULL |
| `users.encrypted_password` | `varchar` | the password **hash** (name misleading) |
| `users.email_confirmed_at` | `timestamptz` | confirmation timestamp |
| `users.phone` / `phone_confirmed_at` | `text`/`timestamptz` | phone factor |
| `users.raw_app_meta_data` | `jsonb` | contains `provider`, `providers[]` |
| `users.raw_user_meta_data` | `jsonb` | profile data (`full_name`, `avatar_url`) |
| `users.banned_until` | `timestamptz` | ban |
| `users.deleted_at` | `timestamptz` | soft delete |
| `users.is_sso_user` / `is_anonymous` / `is_super_admin` | `boolean` | SAML user (never a password) / anonymous / admin |
| `users.created_at` / `updated_at` | `timestamptz` | |
| `users.confirmed_at` | `timestamptz` | **generated column** (`rw:"r"`), not writable |
| `users.confirmation_token`, `recovery_token`, `email_change*`, `reauthentication_token` | `text`/`timestamptz` | one-time tokens and pending states |
| `identities.id` | `uuid` | PK of the identity |
| `identities.provider_id` | `text` | **subject at the provider** (JSON name simply `id`) |
| `identities.user_id` | `uuid` | FK → `auth.users.id` |
| `identities.provider` | `text` | `email`, `google`, `github`, `apple`, … |
| `identities.identity_data` | `jsonb` | raw claims (`sub`, `email`, `email_verified`, `name`) |
| `identities.email` | `text` | **generated column** from `identity_data->>'email'` |
| `mfa_factors.user_id` / `status` | `uuid`/`text` | `unverified` / `verified` |
| `mfa_factors.secret` | `text` | **TOTP secret** — possibly encrypted |
| `mfa_factors.factor_type` | `text` | `totp` / `phone` / `webauthn` |
| `mfa_factors.friendly_name` | `text` | display name |
| `mfa_factors.web_authn_credential` / `web_authn_aaguid` | `jsonb`/`uuid` | passkey credential / authenticator model |

The identity struct has **no** token columns: GoTrue does not persist provider tokens (ibid.).

#### c) Mapping to the Velve Auth schema

| Source field | Target | Transformation |
|---|---|---|
| `users.id` | `velve.user.id` | unchanged — **mandatory** (section 4.0.7) |
| `users.id` | `velve.import_mapping.source_id` | as text |
| `users.email` | `velve.user.email` | trim, NFKC, `lower()` |
| `users.email_confirmed_at` | `velve.user.email_verified_at` | unchanged |
| `raw_user_meta_data->><configured path>` | `velve.user.username` / `.username_key` | NFKC and NFKC + casefold respectively; GoTrue has no username field, only relevant in `username`/`username_email` |
| `users.banned_until` | `velve.user.disabled_at` | `> now() ? banned_until : NULL` — do not carry over expired bans |
| — | `velve.user.imported_from` / `.imported_at` | `'supabase'` / `now()` |
| `users.created_at` / `updated_at` | same name | unchanged |
| `users.encrypted_password` | `velve.password_credential.phc` | PHC string per d), AES-256-GCM under `KeyProvider('password-enc')` (L-2) |
| derived | `velve.password_credential.scheme` | `bcrypt`\|`argon2i`\|`argon2id`\|`fbscrypt`, plaintext |
| — | `velve.password_credential.key_version` | current version of the key `password-enc` (L-2) |
| `identities.provider` | `velve.identity.provider` | mapping; `email` produces **no** identity (that is the password access) |
| `identities.provider_id` | `velve.identity.subject` | unchanged |
| `identities.user_id` | `velve.identity.user_id` | via `import_mapping` |
| `identity_data->>'email'` | `velve.identity.provider_email` | `lower()` |
| `identity_data->>'email_verified'` | `velve.identity.provider_email_verified` | bool cast, default `false` |
| `identity_data` | `velve.identity.profile` | unchanged as `jsonb` |
| — | `velve.identity.access_token_enc`/`refresh_token_enc`/`id_token_enc`/`token_key_version`/`scopes`/`token_expires_at` | **NULL** — GoTrue stores no provider tokens |
| `mfa_factors.secret` (`totp`, `verified`) | `velve.totp_credential.secret_enc` | GoTrue decryption if applicable, then AES-256-GCM under `KeyProvider('totp-enc')` |
| — | `velve.totp_credential.key_version` | current key version |
| `mfa_factors.updated_at` / `created_at` | `.confirmed_at` / `.created_at` | unchanged |
| — | `velve.recovery_code` | **no rows** — GoTrue knows none |
| `web_authn_credential->>'credential_id'`/`'public_key'`/`'sign_count'` | `velve.webauthn_credential.credential_id`/`.public_key`/`.sign_count` | base64url → `bytea`, number; only with opt-in (f) |
| `web_authn_aaguid` / `friendly_name` | `.aaguid` / `.label` | unchanged |
| conservative | `.backup_eligible`/`.backup_state`/`.user_verified_at_registration` | `false` (f) |
| `users.deleted_at IS NOT NULL` | — | **skip** the record |
| `users.is_sso_user` | — | no password → `no_password_in_source` |
| one-time token columns, `auth.sessions`, `auth.refresh_tokens` | — | **discard** (section 3.7) |

#### d) Hash carry-over

`encrypted_password` can contain **three** families (<https://raw.githubusercontent.com/supabase/auth/master/internal/crypto/password.go>): GoTrue only *produces* bcrypt (Go `DefaultCost` = 10), but also *verifies* argon2i/argon2id and `$fbscrypt$`. All three are already canonical in the sense of section 3.3:

```
bcrypt:   "$2a$10$<22><31>"                                  → carry over unchanged, scheme = "bcrypt"
argon2:   "$argon2id$v=19$m=…,t=…,p=…$<salt_b64>$<hash_b64>" → unchanged, scheme = "argon2id"|"argon2i"
          (reject if v != 19 or variant argon2d — GoTrue accepts only i/id)
fbscrypt: "$fbscrypt$v=1,n=<n>,r=<r>,p=<p>,ss=<b64>,sk=<b64>$<salt>$<hash>" → unchanged, scheme = "fbscrypt"

scheme(h) = h.startsWith("$2") ? "bcrypt" : h.startsWith("$argon2id$") ? "argon2id"
          : h.startsWith("$argon2i$") ? "argon2i" : h.startsWith("$fbscrypt$") ? "fbscrypt"
          : UNUSABLE("malformed");     phc = h    // unchanged in all cases
```

The `$fbscrypt$` case is the reason why section 3.3 chose exactly this format: Supabase retrofitted it after Issue #1750/PR #1768 (<https://github.com/supabase/auth/issues/1750>), Velve Auth adopts it 1:1 (`FirebaseScryptKeyLen = 32` on both sides). With that, the Supabase carry-over for all three families is pure copying of the string; it is encrypted only when written (L-2). After the first login `needsRehash` is true in all three cases and the hash silently moves to Argon2id (section 3.3, step 6, and section 4.6).

#### e) What comes with it

User ID unchanged · email and confirmation timestamp · timestamps · password hashes of all three families without conversion · bans (`banned_until` in the future) · provider links with raw claims · TOTP secrets, provided they are unencrypted or the GoTrue key is available · WebAuthn credentials with the same RP ID and opt-in.

#### f) What does not come with it

* **Active sessions and refresh tokens** — not meaningful: Velve sessions are opaque rows with `sha256(token)` (section 3.5), a foreign token has no counterpart.
* **Provider access/refresh tokens** — not present; GoTrue does not persist them. Extent of loss zero.
* **One-time tokens and pending email change** — not meaningful: section 3.7 issues new ones; foreign secrets are never imported.
* **TOTP secrets with encrypted storage on Supabase Cloud** — technically impossible without `GOTRUE_DB_ENCRYPTION_KEY`, which is not handed out there (ESTIMATE; findings report `findings/05-migrationsquellen.md`, section 1.2).
* **Passkeys on a domain change** — technically impossible, RP ID binding.
* **`backup_eligible`/`backup_state`/user verification flag** — not exportable; GoTrue does not store them separately, in section 3.2 they are `NOT NULL`. The default is therefore **no** passkey import; the opt-in `webauthn: 'conservative'` sets both flags to `false` and thereby wrongly marks synchronised passkeys as device-bound — which misleads an application policy.
* **RLS policies, `public` objects, `is_super_admin`, `role`, audit log** — outside the scope (section 3.14).
* **Soft-deleted users** — not meaningful; deleted accounts are not carried over.

#### g) What the user has to do afterwards

1. Before the import, check whether `mfa_factors.secret` is encrypted (recognisable from the format); if it is and the key is missing: plan for TOTP to be set up again.
2. Settle the identity configuration (section 3.4) — with anonymous users without an email, `email` is not selectable.
3. Dry run, read the report, resolve collisions.
4. Write run with `preserveIds: true` (enforced).
5. **Rewrite RLS policies:** replace every `auth.uid()` with your own session resolution. The IDs stay the same, the source of truth does not — the most laborious single task.
6. Re-point foreign keys from `public.*` to `velve.user(id)`.
7. Switch the application over to `@velve/auth`, configure origins.
8. Inform users: signing in again is necessary, and where the TOTP secret is missing, the second factor has to be set up again as well.
9. Delete the `auth` schema only after a grace period, not on the day of the switchover.

#### h) Traps

1. **User IDs must be preserved** — foreign keys and RLS against `auth.uid()`.
2. **No `SELECT *`** — Supabase reserves the right to change the schema at any time.
3. **Generated columns** `users.confirmed_at` and `identities.email` are `rw:"r"`.
4. **`pg_dump --schema=auth` can fail on ownership** (Discussion #3897, Issue #1856).
5. **Three hash families in one column** — whoever expects only bcrypt silently loses argon2 and `$fbscrypt$` users.
6. **`provider = 'email'` is not an OAuth link**, but the password access. Whoever imports it as an identity produces a provider "email" with the email as the subject — exactly what section 3.10 forbids.
7. The pooler on port 6543 does not tolerate long cursors.

---

### 4.2 Clerk

#### a) Obtaining the data

Two sources that must necessarily be joined.

1. **CSV from the dashboard**, self-service since 23.10.2024: button *"Export All Users"*, the download link stays in the dashboard until the file expires; access only for admins or in the personal workspace (<https://clerk.com/changelog/2024-10-23-export-users>). The CSV "includes their hashed passwords" (<https://clerk.com/docs/guides/development/migrating/overview>).
2. **Backend API for everything else** — images, metadata, `external_accounts`, `created_at`:
   ```
   curl -sS -H "Authorization: Bearer $CLERK_SECRET_KEY" \
     "https://api.clerk.com/v1/users?limit=500&offset=0"
   ```
   page by page until empty; mind the rate limiting (the documentation warns explicitly at the `CreateUser` endpoint).
3. Join over `id`.

A support ticket is **no** longer necessary; older guides from WorkOS (<https://github.com/workos/migrate-clerk-users>) and PropelAuth (<https://docs.propelauth.com/migrations/clerk>) are outdated here. **Duration:** ESTIMATE: CSV in minutes; API with 100,000 users = 200 pages, with rate limiting realistically under an hour. The effort lies in the preparation, not in the retrieval.

#### b) Source schema

CSV columns `UNSOURCED:` — Clerk does not document them; list from the Better Auth script (`docs/content/docs/guides/clerk-migration-guide.mdx:195–207`), `password_digest`/`password_hasher` confirmed by <https://github.com/workos/migrate-clerk-users>. API object: <https://clerk.com/docs/reference/backend/types/backend-user>.

| Field | Type | Meaning |
|---|---|---|
| CSV `id` | string | Clerk user ID (`user_…`), join key |
| CSV `username`, `first_name`, `last_name` | string | username, profile |
| CSV `primary_email_address` / `primary_phone_number` | string | primary address / number |
| CSV `verified_email_addresses` / `unverified_email_addresses` | list | confirmed / unconfirmed |
| CSV `verified_phone_numbers` / `unverified_phone_numbers` | list | ditto |
| CSV `totp_secret` | string | **TOTP secret in plaintext** |
| CSV `password_digest` | string | password hash |
| CSV `password_hasher` | string | scheme name, 19 possible values |
| API `externalId` | string \| null | customer's own ID |
| API `emailAddresses[]` / `phoneNumbers[]` | object[] | including verification status |
| API `externalAccounts[]` | object[] | `id`, `provider`, `identification_id`, `provider_user_id`, `approved_scopes`, `email_address`, `created_at`, `updated_at` |
| API `enterpriseAccounts[]` / `web3Wallets[]` | object[] | SSO / wallets |
| API `passwordEnabled`, `totpEnabled`, `twoFactorEnabled`, `backupCodeEnabled` | boolean | **flags only, no secrets** |
| API `banned`, `locked` | boolean | ban state |
| API `createdAt`, `updatedAt` | number | Unix **milliseconds** |
| API `publicMetadata`/`privateMetadata`/`unsafeMetadata`, `imageUrl`, `locale` | object/string | profile |

#### c) Mapping to the Velve Auth schema

| Source field | Target | Transformation |
|---|---|---|
| `id` | `velve.import_mapping.source_id` | unchanged; **not** as `user.id` (no UUID) |
| — | `velve.user.id` | newly produced |
| `primary_email_address` | `velve.user.email` | trim, NFKC, `lower()` |
| contained in `verified_email_addresses` | `velve.user.email_verified_at` | `true` → `createdAt` (ESTIMATE: Clerk exports no confirmation timestamp), otherwise NULL |
| `username` | `velve.user.username` / `.username_key` | NFKC and NFKC + casefold respectively |
| `banned \|\| locked` | `velve.user.disabled_at` | `true` → `now()`; Clerk delivers no ban timestamp |
| — | `velve.user.imported_from` / `.imported_at` | `'clerk'` / `now()` |
| `createdAt`, `updatedAt` (ms) | `velve.user.created_at` / `.updated_at` | `new Date(ms)`, plausibility year 2000–2100 |
| `password_digest` + `password_hasher` | `velve.password_credential.phc` / `.scheme` | PHC string per d), encrypted under `password-enc` (L-2) / plaintext |
| — | `velve.password_credential.key_version` | current version of the key `password-enc` (L-2) |
| `external_accounts[].provider` | `velve.identity.provider` | strip the prefix `oauth_` (`oauth_google`→`google`); anything unknown remains as a generic provider name |
| `external_accounts[].provider_user_id` | `velve.identity.subject` | unchanged |
| `external_accounts[].email_address` | `velve.identity.provider_email` | `lower()` |
| — | `velve.identity.provider_email_verified` | **`false`** — no verification status per external account; conservative, prevents automatic linking per section 3.10 |
| whole `external_accounts[i]` | `velve.identity.profile` | as `jsonb` |
| `approved_scopes` | `velve.identity.scopes` | split on spaces |
| — | `velve.identity.access_token_enc` and others | **NULL** — tokens not in the user object |
| CSV `totp_secret` | `velve.totp_credential.secret_enc` | Base32 plaintext → AES-256-GCM under `KeyProvider('totp-enc')` |
| — | `velve.totp_credential.key_version` / `.confirmed_at` | current key version / `now()` (ESTIMATE: no timestamp in the export) |
| — | `velve.recovery_code` | **no rows** — only `backupCodeEnabled: boolean` available |
| — | `velve.webauthn_credential` | **no rows** — `UNSOURCED:` no export route known |
| `primary_phone_number`, metadata, `imageUrl`, names | — | no target field or outside the scope (section 3.14) |

#### d) Hash carry-over

`password_hasher` **must** be evaluated: on import Clerk accepts 19 schemes and keeps them (<https://clerk.com/docs/reference/backend/user/create-user>; the number follows the enumeration in the descriptive text — the SDK type signature on the same page names a differing set with `ldap_ssha` and `md5_phpass`, which is why the importer treats every unknown value as `unusable` with `detail = 'clerk:<hasher>'`). A tenant that has itself migrated once potentially contains everything.

| `password_hasher` | Velve? | Conversion / reason |
|---|---|---|
| `bcrypt` | **yes** | `"$2a$10$<22><31>"` → unchanged, `scheme = "bcrypt"` |
| `argon2i` / `argon2id` | **yes** | PHC string → unchanged, `scheme = "argon2i"`/`"argon2id"` |
| `pbkdf2_sha256`, `pbkdf2_sha256_django` | **yes** | `"pbkdf2_sha256$<i>$<salt>$<hash_b64>"` → `"$pbkdf2-sha256$i=<i>$<b64(salt)>$<hash_b64>"` |
| `pbkdf2_sha512` | **yes** | analogously → `"$pbkdf2-sha512$i=<i>$<b64(salt)>$<hash_b64>"` |
| `pbkdf2_sha512_hex` | **yes** | as above, but `hex→b64` for the hash |
| `scrypt_werkzeug` | **yes** | `"scrypt:<N>:<r>:<p>$<salt>$<hash_hex>"` → `"$scrypt$ln=log2(N),r=<r>,p=<p>$<b64(salt_ascii)>$<b64(hexToBytes(hash))>"` |
| `scrypt_firebase` | **practically no** | algorithm verifiable (section 4.4), but `signer_key` and `salt_separator` of the original Firebase project are **not** in the Clerk export. Only migratable if the customer still owns the old project and supplies the four parameters |
| `bcrypt_peppered` | **no** | the pepper is a Clerk secret, not part of the export — hash not reproducible |
| `bcrypt_sha256_django` | **no** | Django first hashes to SHA-256 hex and hands *that* to bcrypt: a different scheme from `$2a$`, would need its own line in the switch |
| `awscognito` | **no** | SRP-based, no hash that can be carried over |
| `phpass` | **no** | MD5-based iteration, not in the switch |
| `md5`, `md5_salted` | **no** | cryptographically dead, see section 4.3 d) |
| `sha256`, `sha256_salted`, `sha512_symfony` | **no** | single-round or weakly iterated digests, not memory-hard |
| `pbkdf2_sha1` | **no** | section 3.3 carries only `$pbkdf2-sha256$` and `$pbkdf2-sha512$`; SHA-1 is not taken in |

**Balance: 8 of 19 securely verifiable, a ninth (`scrypt_firebase`) only with foreign parameters, 10 not.** For the 10, section 4.0.5 applies: no row in `password_credential`, marking with `detail = 'clerk:<hasher>'`. `UNSOURCED:` Clerk does not document the exact string form per hasher; the conversions above assume the usual formats (Django, Werkzeug). The importer checks every conversion via `verify()` against a test record and downgrades a scheme without a passed test vector to `unusable` instead of writing blindly. `ESTIMATE:` cost factor 10 for bcrypt; Clerk does not document it.

#### e) What comes with it

Email and verification status · username · ban state · timestamps · password hashes of the eight verifiable schemes · **TOTP secrets** — the rare case in which the second factor is carried over completely, cross-checked against the fact that Clerk's own `createUser` accepts a `totpSecret` "without the need to reset it" · provider links with scopes.

#### f) What does not come with it

* **Hashes of the 10 unsupported schemes** — not meaningful: taking them into the switch would bind Velve Auth permanently to dead cryptography.
* **Backup codes** — not exportable; only `backupCodeEnabled: boolean` (ESTIMATE: stored hashed).
* **Passkeys** — `UNSOURCED:` no documented export route.
* **OAuth provider tokens** — not exportable; retrievable only through a separate, short-lived endpoint.
* **Verification status per external account** — not exportable, conservatively `false`.
* **Organisations** — outside the scope (section 3.14), to be pulled separately through the backend API (<https://workos.com/docs/migrate/clerk>).
* **Phone numbers, profile data, metadata, images** — no target field (section 3.14), they belong in the application tables.

#### g) What the user has to do afterwards

1. Before the export, establish whether the tenant has ever imported from a foreign system — otherwise the `password_hasher` distribution in the dry run comes as a surprise.
2. Pull the CSV **and** the API run as close together in time as possible (snapshot drift).
3. Dry run; `passwords.byScheme` and `unusableByReason` are the basis of the user communication.
4. Supply one test account with a known password per scheme for `verify()`.
5. Write run, then **reconcile stragglers**: another API run, diff against `velve.import_mapping`, second pass.
6. Carry profile data over into your own application tables; rebuild organisations separately.
7. Inform users with an `unusable` marking that a reset mail will arrive at the next login.
8. Tell users with backup codes that the old ones are invalid, and issue new ones in Velve Auth.

#### h) Traps

1. **Never parse the CSV with `split(',')`.** That is exactly what the official Better Auth script does (`clerk-migration-guide.mdx:183–192`, `split(',')` in lines 185 and 187) and it splits rows with a comma in the name or several addresses in one cell wrongly. Velve Auth requires an RFC 4180 parser.
2. **Two data sources necessarily** — the API object contains neither the hash nor the TOTP secret, only `passwordEnabled`/`totpEnabled`. Whoever uses only the API loses both.
3. **Snapshot drift** — users created during the migration are missing (<https://clerk.com/docs/guides/development/migrating/overview>).
4. **Dev and prod instance are separate** — "You cannot migrate users from your Development instance to your Production instance." (ibid.)
5. **No primary flag with multiple emails** in the export format (<https://workos.com/docs/migrate/clerk>) — the choice of the primary address is an assumption.
6. **`createdAt` is Unix ms**, not ISO 8601.

---

### 4.3 Auth0

#### a) Obtaining the data

The most complicated case: profile data and hashes go entirely separate ways.

**(a1) Profile data — Management API job, self-service** (<https://auth0.com/docs/manage-users/user-migration/bulk-user-exports>):

```
curl -X POST "https://$TENANT.auth0.com/api/v2/jobs/users-exports" \
  -H "Authorization: Bearer $MGMT_TOKEN" -H 'content-type: application/json' \
  -d '{"connection_id":"con_…","format":"json",
       "fields":[{"name":"user_id"},{"name":"email"},{"name":"email_verified"},
                 {"name":"username"},{"name":"blocked"},{"name":"created_at"},
                 {"name":"updated_at"},{"name":"identities"},{"name":"multifactor"}]}'
curl "https://$TENANT.auth0.com/api/v2/jobs/$JOB_ID" -H "Authorization: Bearer $MGMT_TOKEN"
curl -L -o users.ndjson "$LOCATION"     # immediately — the link lives 60 seconds
```

`format: "json"` delivers **NDJSON**; CSV can carry at most 30 fields and no metadata objects. Job data are deleted after 24 h, the download link lives 60 s — poll and fetch must run in one go.

**(a2) Password hashes and MFA secrets — only by support ticket** (<https://auth0.com/docs/troubleshoot/customer-support/manage-subscriptions/export-data>, <https://auth0.com/docs/manage-users/user-migration/export-password-hashes-and-mfa-secrets>): (1) produce a PGP key pair, at least RSA 4096, public key ASCII-armored, at most 35,000 characters. (2) Open a support case with the tenant name and public key. (3) Eligibility review by Auth0 — "Not all requests qualify for export". (4) Written authorisation, confirmation by a **second admin**, **signed acknowledgment form with a CISO/CSO/executive signature**. (5) Download link, valid **3 days**, only for the case creator with an active tenant admin role. (6) Decrypt locally (`gpg --decrypt hashes.pgp`); "Never share your private key or passphrase with anyone, including Auth0 or Okta support staff".

Two hard limits: **"This operation is not available for our Free subscription tier."** and "unable to accept or guarantee requests for exports at a specific time and date." **Duration:** ESTIMATE: profile data in minutes; hash export 2–6 weeks — documented is "about a week in total" across several support levels, plus review and the round of signatures (<https://kevcodez.medium.com/migrating-125-000-users-from-auth0-to-supabase-81c0568de307>). Without a paid tier: not at all.

#### b) Source schema

Normalised profile (<https://auth0.com/docs/manage-users/user-accounts/user-profiles/user-profile-structure>); hash fields per the import schema that the support export mirrors in practice (<https://auth0.com/docs/manage-users/user-migration/bulk-user-import-database-schema-and-examples>).

| Field | Type | Meaning |
|---|---|---|
| `user_id` | string | with connection prefix, e.g. `auth0\|abc123`, `google-oauth2\|1179…` |
| `email` / `email_verified` | string / boolean | local part ≤ 64, total ≤ 254 |
| `username` | string | default 1–15 characters, configurable up to 128; lowercased |
| `name`, `given_name`, `family_name`, `nickname`, `picture` | string | profile |
| `phone_number` / `phone_verified` | string / boolean | SMS connections only |
| `blocked` | boolean | ban |
| `created_at`, `updated_at`, `last_login` | datetime | |
| `last_ip`, `logins_count` | string / integer | audit |
| `last_password_reset` | datetime | DB connections only |
| `multifactor` | string[] | enrolled MFA providers |
| `guardian_authenticators[]` | object[] | factors **without** a secret |
| `blocked_for[]` | object[] | brute-force bans |
| `app_metadata` / `user_metadata` | object | roles/permissions and preferences respectively |
| `identities[]` | object[] | `connection`, `provider`, `user_id`, `isSocial`, `profileData`, `access_token`, `refresh_token` |
| `password_hash` | string | bcrypt `$2a$`/`$2b$`, 10 saltRounds |
| `custom_password_hash` | object | `algorithm`, `hash{value,encoding,digest,key}`, `salt{value,encoding,position}`, `password.encoding`, scrypt `keylen`/`cost`/`blockSize`/`parallelization` |
| `mfa_factors[]` | object[] | `{"totp":{"secret":"<base32>"}}`, `{"phone":…}`, `{"email":…}` |

`ESTIMATE:` For standard DB connections the export simply contains bcrypt strings; `custom_password_hash` shows up only with tenants that have themselves imported with foreign hashes. The field structure of the PGP **export** is not documented → `UNSOURCED:`.

#### c) Mapping to the Velve Auth schema

| Source field | Target | Transformation |
|---|---|---|
| `user_id` | `velve.import_mapping.source_id` | complete, **with** prefix |
| — | `velve.user.id` | newly produced |
| `email` | `velve.user.email` | trim, NFKC, `lower()` |
| `email_verified` | `velve.user.email_verified_at` | `true` → `created_at`, otherwise NULL (no timestamp in the export) |
| `username` | `velve.user.username` / `.username_key` | NFKC and NFKC + casefold respectively; check the length against the allowlist (section 3.4) |
| `blocked` | `velve.user.disabled_at` | `true` → `now()` |
| — | `velve.user.imported_from` / `.imported_at` | `'auth0'` / `now()` |
| `created_at`, `updated_at` | same name | ISO 8601 → `timestamptz` |
| `password_hash` / `custom_password_hash` | `velve.password_credential.phc` / `.scheme` | PHC string per d), encrypted under `password-enc` (L-2) / plaintext |
| — | `velve.password_credential.key_version` | current version of the key `password-enc` (L-2) |
| `identities[].provider` | `velve.identity.provider` | **lookup table**, not `split("-")[0]`: `google-oauth2`→`google`, `windowslive`→`microsoft`, `github`/`apple`/`facebook`/`linkedin`/`twitter` unchanged, `oidc`→connection name as a generic provider, `auth0`/`sms`/`email`→**no identity** |
| `identities[].user_id` | `velve.identity.subject` | already prefix-free in the identity object |
| `identities[].profileData.email` / `.email_verified` | `velve.identity.provider_email` / `.provider_email_verified` | `lower()` / bool cast, default `false` |
| `identities[].profileData` | `velve.identity.profile` | as `jsonb` |
| `identities[].access_token` / `refresh_token` | `velve.identity.access_token_enc` / `.refresh_token_enc` / `.token_key_version` | **discarded by default** (f); with `storeTokens: true` AES-256-GCM under `KeyProvider('oauth-token-enc')` |
| `mfa_factors[].totp.secret` | `velve.totp_credential.secret_enc` / `.key_version` | Base32 → AES-256-GCM under `KeyProvider('totp-enc')` |
| `multifactor` not empty | `velve.totp_credential.confirmed_at` | `now()` — no enrolment timestamp in the export |
| — | `velve.recovery_code` | **no rows** — `UNSOURCED:`, plan for them as lost |
| — | `velve.webauthn_credential` | **no rows** — `UNSOURCED:` no export route |
| `app_metadata`, `blocked_for[]`, `logins_count`, `last_ip`, profile fields | — | roles/permissions (section 3.14), rate-limiting state, audit, profile — none of it has a target field |

#### d) Hash carry-over

**Standard case.** Auth0 defines `password_hash` explicitly as bcrypt `$2a$`/`$2b$` with 10 saltRounds:

```
Auth0 password_hash: "$2b$10$<22><31>" → carry over unchanged, scheme = "bcrypt"
```

**Special case `custom_password_hash`** — eleven algorithms, three outcomes:

| `algorithm` | Velve? | Conversion / reason |
|---|---|---|
| `bcrypt` | **yes** | `hash.value` is already MCF → unchanged, `scheme = "bcrypt"` |
| `argon2` | **yes** | `hash.value` is already PHC (`$argon2id$v=19$m=…,t=…,p=…$…$…`) → unchanged; the variant determines `scheme` |
| `scrypt` | **yes** | `"$scrypt$ln=" + log2(cost) + ",r=" + blockSize + ",p=" + parallelization + "$" + b64(decode(salt.value, salt.encoding)) + "$" + b64(decode(hash.value, hash.encoding))`; condition: `cost` a power of two (required by Auth0), `keylen` = length of the decoded hash |
| `pbkdf2` | **conditional** | Only if `hash.value` is a self-describing passlib string with digest, iteration count, salt and hash → `"$pbkdf2-sha256$…"`/`"$pbkdf2-sha512$…"`. `UNSOURCED:` The field table names no iteration parameter for pbkdf2; without it the hash is not reproducible → `unusable`. Passlib's modified Base64 variant (`.` instead of `+`) must be normalised beforehand; without a passed `verify()` test vector nothing is written |
| `hmac` | **no** | single-round MAC, neither iterated nor memory-hard; section 3.3 carries no `$hmac$`, and the key would have to lie permanently in the database |
| `ldap` | **no** | `hash.value` is an LDAP scheme string (`{SSHA}`, `{CRYPT}`) — a format within the format, which would need a switch of its own |
| `md4`, `md5`, `sha1` | **no** | cryptographically dead, see below |
| `sha256`, `sha512` | **no** | single-round digests, not iterated, not memory-hard |

**What does one do with md4, md5, sha1? Nothing.** They are not taken into the switch from section 3.3; the affected users get no password record but a row in `velve.password_reset_required` with `detail = 'auth0:md5'` and the reset path from section 4.0.5. Three reasons: **First, an unsalted MD5/SHA-1 is effectively plaintext** — a single graphics processor computes billions of candidates per second, and every one of these passwords is with high probability already in a breach corpus; to import it means taking a known compromise over into a fresh database. **Second, it would be a permanent burden, not a one-off effort** — every line in the switch is code that has to be maintained, checked and documented forever, and a scheme that exists only because of a migration outlives it by years. **Third, the benefit is small** — the only gain would be that the user gets to keep his old password, which is exactly what one does not want with a dead scheme; the rehash (section 3.3, step 6) would replace it at the first login anyway, and the reset achieves the same without a dead hash ever having lain in the database. The same line holds for `sha256`/`sha512`/`hmac`: **Velve Auth verifies no scheme that is neither iterated nor memory-hard.** That is a rule, not a judgement on an individual case.

**Free tier case:** without a hash export *every* user gets `reason = 'hash_not_exported'`. The only alternative to the reset campaign is a lazy-migration proxy (pass the sign-in through to Auth0, catch the plaintext, hash it immediately with Argon2id) — a product decision with considerable consequences: the proxy sees plaintext passwords, and Auth0 remains in the critical path for the transition period. Velve Auth deliberately supplies no ready-made component for it.

#### e) What comes with it

Email and verification status · username · ban state · timestamps · bcrypt, argon2 and scrypt hashes (with a paid tier and a successful support export) · provider links with `profileData` · TOTP secrets, provided they are contained in the PGP export (`UNSOURCED:` structure).

#### f) What does not come with it

* **All hashes on the free tier** — not exportable: "not available for our Free subscription tier".
* **md4/md5/sha1/sha256/sha512/hmac/ldap hashes** — not meaningful, see d).
* **`pbkdf2` without an iteration parameter** — technically impossible, not reproducible.
* **Refresh tokens of the providers** — practically worthless: bound to the **Auth0 client registration** at the provider; after the switch to your own client IDs no longer redeemable.
* **Access tokens** — practically worthless, expired by the time of the migration.
* **Recovery codes and passkeys** — `UNSOURCED:`, plan for them as lost.
* **Guardian push/SMS factors** — no target model; section 3.6 knows TOTP, WebAuthn, recovery codes.
* **`app_metadata`, organisations, Roles API** — outside the scope (section 3.14).
* **`blocked_for[]`** — not meaningful: section 3.9 builds the state up again itself.

#### g) What the user has to do afterwards

1. **Check the tier first.** Without a paid tier there are no hashes — this question decides the entire strategy and must be answered before anything else.
2. Produce the PGP key pair, open the support case, start the round of signatures — **that is the long path and belongs set in motion first**.
3. In parallel, let the profile export job run (poll and fetch in one go).
4. Dry run on the profile data alone — clear up collisions, username lengths, identity configuration while the hashes are on their way.
5. When the PGP export arrives, decrypt it **immediately** and run pass 2; the link lives 3 days and the timing cannot be planned (documented: 2 a.m. on Easter Saturday).
6. Diff missing users against `velve.import_mapping` and write a row in `password_reset_required` for every miss (documented extent: ~1,600 of 125,000).
7. Check multiple identities from Auth0 account linking — in practice they have led to wrongly merged accounts.
8. Register your own OAuth client IDs with all providers; the Auth0 clients are worthless after the switchover.
9. Inform users: sign in again, in part a password reset, MFA to be set up again depending on the export situation.

#### h) Traps

1. **The support export takes about a week** and passes through several support levels.
2. **No scheduling** — documented extreme case: delivery at night on a public holiday.
3. **Users missing from the final export** — ~1,600 of 125,000 needed reset mails instead of migration.
4. **Global rate limiting of the Management API:** "we quickly ran into a global rate limit that would not even let our own users log out of our system." The limit is tenant-global and hits production — export throttled and outside peak hours.
5. **Duplicate emails across connections** — see section 4.0.6.
6. **`identity.provider.split("-")[0]`** yields "google" for `google-oauth2` by accident, and nonsense for `windowslive` or `oidc` connections. Better Auth does exactly that (`auth0-migration-guide.mdx:208–212`); Velve Auth uses a lookup table with hard rejection for anything unknown.
7. **Job data expire after 24 h, the download link after 60 s.**
8. Better Auth claims that the hash export is "only available for Auth0 Enterprise users" (`auth0-migration-guide.mdx:175–176`) — documented is only its absence on the free tier. For the tier decision the difference is considerable.

---

### 4.4 Firebase Authentication

#### a) Obtaining the data

Two parts, both of which are needed: the export file **and** four parameters that are not in it.

```
npm i -g firebase-tools && firebase login
firebase auth:export users.json --format=json --project <project-id>
```

**JSON, not CSV.** The CSV format (`transUserToArray`, positions 0–27, <https://raw.githubusercontent.com/firebase/firebase-tools/master/src/accountExporter.ts>) loses `mfaInfo` entirely and truncates at four providers per user. The four hash parameters come **by hand** from the Console: *Authentication → Users → ⋮ → Password hash parameters* — "All the parameters below can be obtained from the Firebase Console's users section." (<https://firebase.google.com/docs/auth/admin/import-users>)

| Parameter | Meaning | typical |
|---|---|---|
| `base64_signer_key` | project-wide signer key, is *encrypted*, not used as a salt | 32 bytes |
| `base64_salt_separator` | is appended to every account salt | often `Bw==` |
| `rounds` | scrypt's **`r`** (block size!) | often `8` |
| `mem_cost` | exponent for **`N = 2^mem_cost`** | often `14` |

Without these four values the export is worthless; `probe()` reports them in `missingRequiredConfig`, and before the write run a passed `verify()` run against a test user is mandatory. **Duration:** ESTIMATE: export minutes to an hour depending on the population, Console step minutes; the time sink is the parameter validation — which absolutely belongs before the switchover.

#### b) Source schema

`firebase auth:export --format=json`, one object per user (example: <https://fusionauth.io/docs/lifecycle/migrate-users/bulk/firebase>).

| Field | Type | Meaning |
|---|---|---|
| `localId` | string | Firebase UID, 28 characters |
| `email` / `emailVerified` | string / boolean | confirmation **status**, no timestamp |
| `passwordHash` | string | **standard Base64**, 64 bytes raw (88 characters) |
| `salt` | string | **standard Base64**, per account |
| `displayName`, `photoUrl` | string | profile |
| `createdAt`, `lastSignedInAt` | string | **Unix milliseconds as a string**; `lastSignedInAt` is called `lastLoginAt` in the source |
| `phoneNumber` | string | phone number |
| `disabled` | boolean | ban |
| `customAttributes` | string (JSON) | custom claims |
| `providerUserInfo[]` | object[] | `providerId`, `rawId`, `email`, `displayName`, `photoUrl` |
| `mfaInfo[]` | array | SMS factors; `ESTIMATE:` `phoneInfo` + `mfaEnrollmentId`, **no secrets** |

The CLI converts `passwordHash` and `salt` from URL-safe into normal Base64 and filters `providerUserInfo` down to known `providerId` values.

#### c) Mapping to the Velve Auth schema

| Source field | Target | Transformation |
|---|---|---|
| `localId` | `velve.import_mapping.source_id` | unchanged; **not** as `user.id` (no UUID) |
| — | `velve.user.id` | newly produced |
| `email` | `velve.user.email` | trim, NFKC, `lower()` |
| `emailVerified` | `velve.user.email_verified_at` | `true` → `createdAt`, otherwise NULL |
| — | `velve.user.username` / `.username_key` | **NULL** — Firebase knows no username; the configurations `username`/`username_email` (section 3.4) need an additional source |
| `disabled` | `velve.user.disabled_at` | `true` → `now()` |
| — | `velve.user.imported_from` / `.imported_at` | `'firebase'` / `now()` |
| `createdAt` | `velve.user.created_at` | `new Date(parseInt(s, 10))`, plausibility 2000–2100 |
| `passwordHash` + `salt` + `hash_config` | `velve.password_credential.phc` | `$fbscrypt$` string per d), encrypted under `password-enc` (L-2) |
| — | `velve.password_credential.scheme` | `'fbscrypt'`, plaintext |
| — | `velve.password_credential.key_version` | current version of the key `password-enc` (L-2) |
| `providerUserInfo[].providerId` | `velve.identity.provider` | strip the `.com` suffix (`google.com`→`google`, `apple.com`→`apple`, …); `password` and `phone` produce **no** identity |
| `providerUserInfo[].rawId` | `velve.identity.subject` | unchanged |
| `providerUserInfo[].email` | `velve.identity.provider_email` | `lower()` |
| — | `velve.identity.provider_email_verified` | **`false`** — no status per provider in the export; conservative (section 3.10) |
| whole `providerUserInfo[i]` | `velve.identity.profile` | as `jsonb` |
| — | `velve.identity.access_token_enc` and others | **NULL** — no tokens in the export |
| — | `velve.totp_credential`, `velve.recovery_code`, `velve.webauthn_credential` | **no rows** — see f) |
| `mfaInfo[]`, `customAttributes`, `phoneNumber`, `displayName`, `photoUrl`, `lastSignedInAt` | — | no target model or outside the scope |

#### d) Hash carry-over

Firebase uses "an internally modified version of scrypt" (<https://github.com/firebase/scrypt>). The derivation, documented via the reference implementation (<https://raw.githubusercontent.com/nhairs/firebase-scrypt/main/src/firebase_scrypt/firebasescrypt.py>, confirmed by <https://gist.github.com/Meldiron/eecf84a0225eccb5a378d45bb27462cc> and the Go port <https://pkg.go.dev/github.com/Aoang/firebase-scrypt>):

1. `salt_bytes = base64decode(user.salt)`, `sep_bytes = base64decode(base64_salt_separator)`
2. `dk = scrypt(utf8(password), salt_bytes || sep_bytes, N = 2^mem_cost, r = rounds, p = 1, dkLen = 64)`
3. `aesKey = dk[0..32]` — "only use first 32 bytes … to match expected key length"
4. `out = AES-256-CTR(key = aesKey, IV = 16 null bytes).encrypt(base64decode(base64_signer_key))`
5. compare `base64(out)` **in constant time** with `user.passwordHash`

The signer key is thus *encrypted*, not hashed; the scrypt result is the AES key. Constants: `p = 1`, `KeyLen = 32` ("required for AES-256", <https://raw.githubusercontent.com/supabase/auth/master/internal/crypto/password.go>). The conversion per section 3.3:

```
Firebase: passwordHash(b64) + salt(b64) + hash_config
  → "$fbscrypt$v=1,n=<mem_cost>,r=<rounds>,p=1,ss=<salt_separator>,sk=<signer_key>$<salt_b64>$<hash_b64>"
    scheme = "fbscrypt"

phc = `$fbscrypt$v=1,n=${cfg.mem_cost},r=${cfg.rounds},p=1,` +
      `ss=${cfg.base64_salt_separator},sk=${cfg.base64_signer_key}$` +
      `${toStandardB64(u.salt)}$${toStandardB64(u.passwordHash)}`
```

That is bit for bit the format GoTrue uses (regex: `^\$fbscrypt\$v=(?P<v>[0-9]+),n=(?P<n>[0-9]+),r=(?P<r>[0-9]+),p=(?P<p>[0-9]+)(?:,ss=…)?(?:,sk=…)?\$(?P<salt>[^$]+)\$(?P<hash>.+)$`). The verifier reads `n` as an **exponent** and computes `N = 2^n` — consistent with `ln=` in the PHC scrypt format.

**Trap 1 — the parameter mix-up.** `rounds` is **not** the iteration count but scrypt's `r` (block size); `mem_cost` is **not** the memory in megabytes but the exponent for `N`. Whoever swaps the two gets a hash that never matches — **without an error message**. That is exactly why `verify()` with a test vector is mandatory.

**Trap 2 — Node's `maxmem`.** The memory requirement is `128 · N · r`; with `mem_cost = 14`, `rounds = 8` that is `128 · 16384 · 8 ≈ 16 MiB` — Node's built-in `crypto.scrypt` limits to `maxmem = 32 MB` by default, which just fits. With `mem_cost = 15` it is 32 MiB and the call fails with `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` as long as `maxmem` is not raised (`{ maxmem: 256*1024*1024 }`). Section 2.7 prescribes `@noble/hashes/scrypt` anyway, which does not know this limit — but the memory is occupied all the same, and the KDF semaphore from section 3.3 must count `fbscrypt` checks along with the rest (16 MiB per call against 19 MiB with Argon2id).

**Trap 3 — Base64 variant.** The CLI delivers standard Base64; whoever taps the `identitytoolkit` REST API directly gets URL-safe Base64 and has to convert. The PHC string requires standard Base64. After the first login `needsRehash` is true and the hash silently moves to Argon2id (section 3.3, step 6) — the signer key is afterwards only relevant for the leftovers.

#### e) What comes with it

Email and verification status · ban state · creation timestamp · **all password hashes without loss** as `$fbscrypt$` · provider links (`providerId` + `rawId` + email/name/image).

#### f) What does not come with it

* **TOTP factors** — not exportable: TOTP exists only in Google Cloud Identity Platform, and `UNSOURCED:` no evidence was found that `auth:export` outputs the shared secrets. Plan for them as **not migratable**.
* **SMS factors (`mfaInfo`)** — no target model (section 3.6).
* **Recovery codes and passkeys** — do not exist in Firebase Auth.
* **OAuth provider tokens** — not present in the export.
* **Usernames** — do not exist; `username`/`username_email` need an additional data source.
* **The confirmation *timestamp* of the email** — not exportable, only the boolean.
* **Custom claims, Firestore rules** — outside the scope (section 3.14); rules have to be rewritten.

#### g) What the user has to do afterwards

1. Fetch the four hash parameters from the Console and treat them like a master key — with the signer key all hashes are attackable offline (in practice scrypt protects against that, for compliance it is nevertheless a secret of the first rank).
2. **Before the export**, create a test user with a known password and run `verify()` against him. Without a passed test vector there is no write run.
3. Dry run; pay particular attention to `passwords.none` — OAuth-only, phone and anonymous users have no hash, and that is the **normal case**, not an error.
4. Settle the identity configuration on `email`, provided no username source exists.
5. Write run; afterwards register the provider client IDs anew, the Firebase OAuth clients fall away.
6. Inform users with TOTP: the second factor has to be set up again.
7. Treat Apple users separately: Apple delivers the full name only at the very first login, for migrated users never again (<https://fusionauth.io/docs/lifecycle/migrate-users/bulk/firebase>) — whoever needs names must secure them from `displayName` now.
8. Remove the signer key from the configuration after the complete rehash of all users.

#### h) Traps

1. **`rounds` ↔ `mem_cost` swapped** — fails silently.
2. **Node's `maxmem` limit** from `mem_cost >= 15`.
3. **Users without a `passwordHash` are normal** (OAuth, phone, anonymous) — not an error case.
4. **`createdAt` is a string with Unix milliseconds**, not ISO 8601.
5. **CSV loses data** — `mfaInfo` falls away, providers are truncated at four. Always JSON.
6. **The Base64 variant** differs depending on the route of acquisition.
7. **The signer key is a project secret** and inevitably ends up in the migration configuration.
8. **No Better Auth guide as a comparison** — for the only source with a genuinely difficult scheme there exists no foreign guide against which one could check oneself.

---

### 4.5 Auth.js / NextAuth.js

#### a) Obtaining the data

No export necessary: Auth.js is a library, the data lie in the customer's database (<https://authjs.dev/getting-started/adapters/prisma>).

1. Establish the actual schema — it varies by adapter: `npx prisma db pull` or `psql "$DB_URL" -c "\d+ users"`.
2. Clarify **where the password lies.** Auth.js has no field for it; every project has built it itself. The importer takes that as configuration:
   ```ts
   passwordSource: {
     table: 'users', userIdColumn: 'id', hashColumn: 'passwordHash',
     format: 'phc' | 'bcrypt-mcf' | 'better-auth-scrypt' | 'custom',
     custom?: (raw: string) => PasswordOutcome
   }
   ```
3. Read: `psql "$DB_URL" -c "\copy (SELECT id, name, email, \"emailVerified\", image FROM users ORDER BY id) TO 'users.csv' CSV HEADER"`, analogously for `accounts` and `authenticators`.

**Duration:** ESTIMATE: minutes for the extraction; the effort lies entirely in step 2.

#### b) Source schema

Drizzle/Postgres reference (<https://raw.githubusercontent.com/nextauthjs/next-auth/main/packages/adapter-drizzle/src/lib/pg.ts>).

| Field | Type | Meaning |
|---|---|---|
| `users.id` | `text` PK | default `crypto.randomUUID()` (Drizzle) or `cuid` (Prisma) |
| `users.name` / `users.image` | `text` | display name / image |
| `users.email` | `text` UNIQUE | **optional** |
| `users.emailVerified` | `timestamp` | **timestamp**, not a boolean |
| `accounts.userId` | `text` → `users.id` | FK, `ON DELETE CASCADE` |
| `accounts.type` | `text` | `oauth` / `oidc` / `email` / `credentials` |
| `accounts.provider` / `.providerAccountId` | `text` | provider name / **subject at the provider** |
| `accounts.refresh_token` / `.access_token` / `.id_token` | `text` | provider tokens |
| `accounts.expires_at` | `integer` | Unix **seconds** |
| `accounts.token_type` / `.scope` / `.session_state` | `text` | |
| `sessions.sessionToken` / `.userId` / `.expires` | `text`/`text`/`timestamp` | only with `strategy: "database"` |
| `verificationTokens.identifier` / `.token` / `.expires` | `text`/`text`/`timestamp` | one-time tokens |
| `authenticators.credentialID` | `text` UNIQUE | passkey ID |
| `authenticators.userId` / `.providerAccountId` | `text` | FK / provider account |
| `authenticators.credentialPublicKey` | `text` | public key |
| `authenticators.counter` | `integer` | signature counter |
| `authenticators.credentialDeviceType` | `text` | `singleDevice` / `multiDevice` |
| `authenticators.credentialBackedUp` | `boolean` | backup state |
| `authenticators.transports` | `text` | comma-separated list |
| *(project-specific)* | | password hash column, see a) |

Prisma uses `id` as the PK for `Account`, Drizzle a composite PK `(provider, providerAccountId)` and has no `Account.id` at all — the reader must tolerate both layouts.

#### c) Mapping to the Velve Auth schema

| Source field | Target | Transformation |
|---|---|---|
| `users.id` | `velve.import_mapping.source_id` | unchanged |
| `users.id` | `velve.user.id` | **carry over if a UUID** (Drizzle default); with `cuid` produce a new one (section 4.0.7) |
| `users.email` | `velve.user.email` | trim, NFKC, `lower()`; can be NULL |
| `users.emailVerified` | `velve.user.email_verified_at` | **carry over directly** — here, exceptionally, a real timestamp is present |
| *(project-specific)* | `velve.user.username` / `.username_key` | only if the project has a username column |
| — | `velve.user.disabled_at` | **NULL** — Auth.js knows no ban state |
| — | `velve.user.imported_from` / `.imported_at` | `'nextauth'` / `now()` |
| — | `velve.user.created_at` / `.updated_at` | `now()` — neither the Drizzle nor the Prisma reference schema carries `createdAt`; a project-specific column is configured like the hash column |
| hash column | `velve.password_credential.phc` / `.scheme` | PHC string per d), encrypted under `password-enc` (L-2) / plaintext |
| — | `velve.password_credential.key_version` | current version of the key `password-enc` (L-2) |
| `accounts.provider` (with `type ∈ {oauth,oidc}`) | `velve.identity.provider` | unchanged; `type = 'credentials'` produces **no** identity |
| `accounts.providerAccountId` | `velve.identity.subject` | unchanged |
| — | `velve.identity.provider_email` / `.provider_email_verified` | NULL / `false` — Auth.js does not store them per account |
| `accounts` (whole row) | `velve.identity.profile` | as `jsonb` |
| `accounts.scope` | `velve.identity.scopes` | split on spaces |
| `accounts.refresh_token` | `velve.identity.refresh_token_enc` | **carry over**, AES-256-GCM under `KeyProvider('oauth-token-enc')` |
| `accounts.access_token` | `velve.identity.access_token_enc` | ditto, only if `expires_at` is in the future |
| `accounts.id_token` | `velve.identity.id_token_enc` | only with `storeTokens: true`; a snapshot, mostly worthless |
| — | `velve.identity.token_key_version` | current key version |
| `accounts.expires_at` | `velve.identity.token_expires_at` | `new Date(sec * 1000)` |
| `authenticators.credentialID` / `.credentialPublicKey` | `velve.webauthn_credential.credential_id` / `.public_key` | base64url → `bytea` |
| `authenticators.counter` | `.sign_count` | number → `bigint` |
| `authenticators.transports` | `.transports` | `split(',')` → `text[]` |
| `authenticators.credentialDeviceType` | `.backup_eligible` | `=== 'multiDevice'` |
| `authenticators.credentialBackedUp` | `.backup_state` | unchanged |
| — | `.user_verified_at_registration` / `.aaguid` | **`false`** / **NULL** — Auth.js stores neither; lossy (f) |
| `authenticators.userId` | `.user_id` | via `import_mapping` |
| — | `velve.totp_credential`, `velve.recovery_code` | **no rows** — Auth.js core has no TOTP; a self-built factor is a special case for a project-specific hook |
| `sessions.*`, `verificationTokens.*`, `users.name`, `users.image` | — | discard (f) or outside the scope |

#### d) Hash carry-over

**Auth.js does not hash passwords.** Verbatim: "By default, the Credentials provider does not persist data in the database. However, you can still create and save any data in your database, you just have to provide the necessary logic, eg. to encrypt passwords …" (<https://authjs.dev/getting-started/authentication/credentials>). There is consequently no Auth.js password format that an importer could hard-wire — only a configurable read-off path and a format declaration. The importer masters four formats without additional code:

```
bcryptjs/bcrypt:  "$2a$10$<22><31>" or "$2b$…"              → unchanged, scheme = "bcrypt"
argon2/@node-rs:  "$argon2id$v=19$m=…,t=…,p=…$<s_b64>$<h_b64>" → unchanged, scheme = "argon2id"
PHC scrypt:       "$scrypt$ln=…,r=…,p=…$<s_b64>$<h_b64>"     → unchanged, scheme = "scrypt"
Better Auth style "salt_hex:hash_hex":
  → "$scrypt$ln=14,r=16,p=1$" + b64(ascii(salt_hex)) + "$" + b64(hexToBytes(hash_hex))
    scheme = "scrypt"          (N = 16384 = 2^14, r = 16, p = 1, dkLen = 64; section 3.3)
```

Two peculiarities of the Better Auth format, documented in `@better-auth/utils` (findings report `findings/06-krypto-bibliotheken.md`, "Die präfixlosen Formate"): the salt goes into scrypt as an **ASCII hex string of 32 bytes**, not as the 16 decoded bytes — hence `ascii(salt_hex)` and not `hexToBytes(salt_hex)`. And the password is **NFKC-normalised** before the call (`password.normalize("NFKC")`, `packages/better-auth/src/crypto/password.test.ts:75–76`). `Section 3.3 lays down NFKC before every KDF call; converted Better Auth hashes therefore also verify for passwords outside ASCII. The `verify()` test vector for this format must therefore contain a non-ASCII password.

Everything else goes through `passwordSource.custom`, a pure function `(raw: string) => PasswordOutcome`. It may only issue into one of the PHC strings from section 3.3 or return `unusable` — it may **not** invent a new format. `ESTIMATE:` bcrypt via `bcryptjs` is the most widespread in Auth.js projects; that is not documented. `verify()` is mandatory here too: a self-built password field is the most error-prone of all five sources, because nobody but the project knows what is in it.

#### e) What comes with it

User IDs (unchanged with UUID adapters) · email and a **real confirmation timestamp** · password hashes with a supported format · provider links with scopes · **refresh tokens** — the only case among the five sources in which provider tokens keep their value, because the OAuth client ID can stay the same across a library change (unlike with Auth0 or Clerk, where it is registered to the provider) · **passkeys completely** (`credentialID`, `credentialPublicKey`, `counter`, `credentialDeviceType`, `credentialBackedUp`, `transports`); the `counter` must necessarily travel along, otherwise the replay check fails.

#### f) What does not come with it

* **Passkeys on a domain change** — technically impossible, RP ID binding.
* **`user_verified_at_registration` and `aaguid`** — not exportable; Auth.js stores neither, in section 3.2 the former is `NOT NULL` → conservatively `false`. An application that bases a policy on it must treat imported credentials separately.
* **Active sessions** — not meaningful: with `strategy: "jwt"` (the default in v5) there are no rows at all; with database sessions the token format is a different one. "Due to different session management methods, existing users need to re-login after migration." (<https://dev.to/pipipi-dev/nextauthjs-to-better-auth-why-i-switched-auth-libraries-31h3>)
* **`verificationTokens`** — technically transferable, but not meaningful: section 3.7 issues its own one-time artefacts.
* **`id_token`, expired `access_token`, `session_state`** — practically worthless or no target field.
* **TOTP / second factor** — not standardised; Auth.js core has no TOTP, the format is project-specific (`UNSOURCED:`).
* **Ban state** — does not exist in Auth.js.
* **`users.name`, `users.image`** — outside the scope (section 3.14).

#### g) What the user has to do afterwards

1. Establish the actual schema — field names differ between adapters (`sessionToken` vs. `token`, `expires` vs. `expiresAt`, `providerAccountId` vs. `accountId`).
2. Document your own password format and provide a test vector.
3. Check whether `users.id` is a UUID everywhere. If it is: `preserveIds: true`, all application foreign keys stay valid. With `cuid`: new IDs, and the foreign keys have to be rewritten via `velve.import_mapping` — the most laborious part.
4. Check whether the RP ID stays unchanged; if not, do not import passkeys and ask users to register again.
5. Decide whether provider tokens are needed — `storeTokens: false` is the default (section 3.10).
6. Dry run; pay particular attention to users without an email: `users.email` is optional, the configuration `email` (section 3.4) requires it.
7. Write run.
8. **Keep** the OAuth client IDs, otherwise the migrated refresh tokens become worthless.
9. Inform users: signing in again is necessary, passwords and passkeys stay valid.

#### h) Traps

1. **Two adapter conventions** — Prisma has `Account.id`, Drizzle does not; table names vary between `User` and `users`. Hard-wired names fail on half the projects.
2. **`emailVerified` is `DateTime?`, not a boolean** — whoever maps it to a boolean loses the date. Velve Auth carries the timestamp over directly; the only source where that is possible.
3. **`users.email` is optional** — target systems with `NOT NULL` break; in Velve Auth the identity configuration decides that.
4. **JWT sessions leave no trace** — after the switchover all cookies are invalid, without any table showing it.
5. **v4 vs. v5 does not change the schema** ("v5 does not introduce any breaking changes to the database schema", <https://authjs.dev/getting-started/migrate-to-better-auth>) — the configuration does.
6. **Do not forget the `counter`** — a signature counter reset to 0 makes section 3.6 report a suspected clone.
7. **Better Auth supplies no data migration script for Auth.js**, only a schema comparison (`next-auth-migration-guide.mdx`, 795 lines) — there is no foreign template here to check against.

---

### 4.6 Comparison with Better Auth's migration route

In **all three** password guides Better Auth recommends switching the global hash hook to bcrypt — Supabase: `docs/content/docs/guides/supabase-migration-guide.mdx:969–971` ("By default, Better Auth uses the `scrypt` algorithm to hash passwords. Since Supabase uses `bcrypt`, you'll need to configure Better Auth to use bcrypt for password verification.", followed by a `password.hash`/`password.verify` pair with `bcrypt.hash(password, 10)`), word for word in `auth0-migration-guide.mdx:595` and `:608–617`, to the same effect in `clerk-migration-guide.mdx:47` and `:61–74`. That is wrong for four reasons. **First, the hook is global and not per record:** it is also used for new registrations and every password change, so a one-off carry-over measure becomes a permanent downgrade of the default scheme — the project hangs on bcrypt(10) forever and for all users, and the guides mention that nowhere. **Second, it works only with homogeneous populations:** a Supabase tenant can contain three hash families (<https://github.com/supabase/auth/issues/1750>), a Clerk tenant up to 19 (<https://clerk.com/docs/reference/backend/user/create-user>), an Auth0 tenant eleven (<https://auth0.com/docs/manage-users/user-migration/bulk-user-import-database-schema-and-examples>); a pure bcrypt hook fails on every record that is not bcrypt — as a sign-in error without explanation. The Auth0 guide half recognises this and pushes it onto the reader ("For custom password hashing algorithms, you'll need to modify the `migratePassword` function", `auth0-migration-guide.mdx:588`, to the same effect once more at `:713`). **Third, the rehash is missing:** because the global hook makes the scheme into the new constant, there is no way back; the imported hashes never get better, not even after years. **Fourth, it cements a known weakness:** bcrypt truncates inputs at 72 bytes, and whoever stays globally on bcrypt keeps this truncation permanently instead of being rid of it at the first login. — **Velve Auth does three things instead:** the scheme stands *per record* in the canonical PHC string, the switch decides on the prefix (section 3.3), and the default remains Argon2id unchanged — an import does not change the application's password policy. At the first successful login `needsRehash` is true for every foreign hash, and the record is silently, without user interaction, raised to Argon2id by compare-and-swap (section 3.3, step 6, and section 4.6). A population with three or nineteen schemes is thereby not a problem but a statistic that the dry run reports and that goes towards zero in the weeks after the switchover. In addition: Better Auth has **no guide for Firebase at all** — there are guides for Supabase, Clerk, Auth0, Auth.js and WorkOS, but for the one source with a non-trivial hash scheme of all things, none (findings report `findings/05-migrationsquellen.md`, section 6).

---

### 4.7 Summary across all five sources

| Source | Hashes exportable? | Hash scheme | Verifiable by Velve? | 2FA carryable? | OAuth links carryable? | Effort (ESTIMATE) |
|---|---|---|---|---|---|---|
| **Supabase** | **yes**, trivially (`SELECT` on `auth.users`) | bcrypt(10); additionally argon2i/argon2id and `$fbscrypt$` possible | **yes, all three families, without conversion** | TOTP only with an unencrypted `mfa_factors.secret` or an available GoTrue key — on managed Supabase mostly not; passkeys technically yes, but without BE/BS flags; no recovery codes | **yes** (`provider` + `provider_id`); tokens do not exist | **1–3 person-days** plus the RLS rebuild, which depending on the project can be a multiple of that |
| **Clerk** | **yes**, self-service since 2024-10-23 (dashboard CSV) | bcrypt; on import up to 19 schemes permitted | **8 of 19 securely** (bcrypt, argon2i/id, pbkdf2\_sha256/\_django/\_sha512/\_sha512\_hex, scrypt\_werkzeug); `scrypt_firebase` only with foreign parameters; 10 not | **TOTP yes** (`totp_secret` in plaintext in the CSV); backup codes no; passkeys `UNSOURCED:` no | **yes** (`external_accounts`); tokens no | **2–4 person-days** (join CSV + API, RFC 4180 parser, straggler reconciliation) |
| **Auth0** | **no** through the API; only a support ticket with a PGP key, a second admin and a CISO signature, **not on the free tier** | bcrypt `$2a$`/`$2b$`, 10 rounds; `custom_password_hash` with 11 algorithms | bcrypt, argon2, scrypt **yes**; pbkdf2 conditionally; hmac, ldap, md4, md5, sha1, sha256, sha512 **no** | TOTP secrets in the PGP export (`UNSOURCED:` structure); recovery codes no; passkeys `UNSOURCED:` no | **yes** (`identities[]`); tokens present, but practically worthless | **3–8 person-days of active work, 2–6 weeks of calendar time** because of the support process; on the free tier: a reset campaign for 100 % of the users |
| **Firebase** | **yes**, contained in the CLI export | modified scrypt (scrypt → AES-256-CTR over the signer key) | **yes, completely**, as `$fbscrypt$` — the same format GoTrue uses | **no**: TOTP only in Cloud Identity Platform and `UNSOURCED:` not in the export; SMS factors without a target model; no recovery codes; no passkeys | **yes** (`providerUserInfo[]`); tokens do not exist | **2–4 person-days**, of which a considerable share goes on validating the four hash parameters |
| **Auth.js / NextAuth** | n/a — own database, full access | **none** (Auth.js does not hash); what is there, the project built itself | Project-dependent: bcrypt, argon2, PHC scrypt and Better Auth `salt:hash` **yes**, everything else through your own mapper or not at all | No TOTP in the core (project-specific, `UNSOURCED:`); **passkeys completely carryable** with the same RP ID | **yes** (`accounts`); **refresh tokens keep their value** — the only source for which that holds | **1–3 person-days**, provided the IDs are UUIDs; with `cuid` IDs plus the rewriting of all application foreign keys |

**Across all five it holds:** active sessions are always lost, every migration forces all users to sign in again, and all one-time tokens are discarded. That belongs in the communication plan, not in a footnote.

---

## 5. Security requirements

This section translates the decisions of the target architecture (section 3) into consecutively numbered, testable requirements. Every requirement is a statement about the finished system in the indicative and names in parentheses the place in section 3 from which it follows. Section 6 assigns at least one test case to every requirement.

Structure per error class: **(a)** what goes wrong mechanically, **(b)** the precedent with GHSA/CVE, **(c)** the requirements `S-<class>-<n>`. The basis of the precedents is the research report `findings/07-sicherheit.md` (33 Better Auth advisories, reference code base `better-auth` @ `e025ce6`, package version 1.7.3); the CVSS values and fix versions were checked against the GitHub advisory database.

The design is **not** changed here. Where the elaboration exposed a gap in the target architecture, it is decided in section 3.16 as L-1 to L-13; section 5.20 assigns these decisions to the affected requirements.

---

### 5.1 TIM — Timing attacks

**(a) The error class.** Constant runtime is not a property of the comparison function but of the entire request path. An early `return` before the KDF runs produces a signal of 50–250 ms and is visible over the network with a few dozen measurements; an early-exit string comparison on a secret produces a sub-nanosecond signal that only an in-process attacker can exploit. Between them lie data-dependent database paths (index hit vs. miss, additional join) in the range 0.1–2 ms. The attacker uses the signal not to guess a password but to reduce a list of 10 million addresses to the few thousand that actually have accounts at this service.

**(b) The precedent.** Better Auth deliberately calls `ctx.context.password.hash(password)` when the user is missing (`packages/better-auth/src/api/routes/sign-in.ts:537-546`, with the comment "Hash password to prevent timing attacks"), but uses `hash()` instead of `verify()` — different costs, because `hash()` additionally generates salt and `verify()` parses the PHC string. More serious: the branch `requireEmailVerification && !user.emailVerified` (`sign-in.ts:569-597`) runs **after** the password verify and can trigger an email dispatch — a timing *and* status code leak at the same time. `constantTimeEqual` (`packages/better-auth/src/crypto/buffer.ts:4-24`) is implemented correctly, but is used in the core package only in the OTP modules (`plugins/email-otp/otp-token.ts`, `plugins/two-factor/otp/index.ts:366`); the session token comparison runs over a lookup on a cleartext column.

**(c) The requirements.**

- **S-TIM-1:** Every password-accepting endpoint runs through the same sequence of database and KDF calls in the same order for existing and non-existing identifiers; after the length check (step 1, which depends only on the input) there is no `return` and no `throw` between step 2 and step 4 of the check sequence, the error state is accumulated in a local variable. *(Section 3.3, course of a password check, steps 1–4: "The code path is the same.")*
- **S-TIM-2:** If no user exists for the entered identifier, the core checks against a dummy PHC whose scheme and parameters (`m = 19456`, `t = 2`, `p = 1`, 16 bytes of salt, 32 bytes of output) are identical to the configured default parameters, and in doing so calls the same verifier that the real path calls — not the generation function. *(Section 3.3 step 2 and the default parameter paragraph)*
- **S-TIM-3:** The comparison of the KDF result is made in constant time over buffers of equal length; the library contains no `===`, `==`, `startsWith`, `includes` or `localeCompare` comparison on a value of type `Secret<…>`. *(Section 3.3 step 3: "compare the result in constant time")*
- **S-TIM-4:** The resolution of a session looks up `sha256(token)` exclusively; the cleartext token is never used as a database predicate, so that the lookup time does not depend on the cleartext token. *(Section 3.5, "Only `sha256(token)` is stored"; schema `velve.session.token_sha256` with `UNIQUE`)*
- **S-TIM-5:** The rehash after a successful sign-in (`needsRehash`) runs in a background task **after** the response has been sent and does not lengthen the measured response time of the sign-in. *(Section 3.3 step 6: "after sending the response in a bounded background task")*
- **S-TIM-6:** Every endpoint whose response must be identical for existing and non-existing accounts has exactly one code path that performs the same work regardless of the outcome: at password endpoints one KDF call with identical parameters (S-TIM-2), at endpoints without a KDF — request reset, request magic link; the confirmation is requested only from a session and has no non-existence branch (B.5) — the same sequence of database queries and in every case exactly one call of the send callback, in which it is only then decided which message goes out. The account-related rate counter is advanced on the same row for both cases (S-RATE-7). There is no configurable minimum response duration. *(Section 3.16, L-1; section 3.13: "Server-side the true reason is always logged")*
- **S-TIM-7:** The state `email_verified_at IS NULL` does not influence the sign-in: it delivers the same session as with a confirmed address, and the state is visible exclusively as `User.emailVerifiedAt` in the result. There is no lock on unconfirmed accounts (section 1, A5). *(Section 3.15, B.1 and B.5)*

### 5.2 FIX — Session fixation

**(a) The error class.** Fixation exists when a session identifier that the attacker knows survives a change of trust level. With opaque database tokens the classic URL variant falls away; three real routes remain: an anonymous row is promoted to the authenticated row by `UPDATE session SET user_id`; a privilege change (completion of the second factor, password change) changes only one field instead of replacing the row; or the old cookie survives because the new one carries a different `Path` or `Domain` and the browser sends both.

**(b) The precedent.** Better Auth correctly creates a new session on completion of the second factor (`packages/better-auth/src/plugins/two-factor/verify-two-factor.ts:83`). It does, however, nowhere set the `__Host-` prefix: `HOST_COOKIE_PREFIX` exists in `packages/better-auth/src/cookies/cookie-utils.ts:35` but is read only when *removing* prefixes, while `createCookieGetter` (`packages/better-auth/src/cookies/index.ts:75`) sets exclusively `__Secure-`. Cookie tossing from a subdomain is thereby not structurally prevented. The related variant is GHSA-wmjr-v86c-m9jj (2.0 Low): the multi-session sign-out hook passed raw cookie values unchecked to `internalAdapter.deleteSessions`.

**(c) The requirements.**

- **S-FIX-1:** Every sign-in, every completion of the second factor, every password change and every linking of a new identity creates a new row in `velve.session` with a newly generated token and deletes the previous row in the **same** transaction. *(Section 3.5, "Re-issue … Always as an `INSERT` of a new row plus a `DELETE` of the old one in one transaction")*
- **S-FIX-2:** The library contains no statement that updates `velve.session.user_id`; a lint rule rejects such a call in the source and a database trigger rejects an `UPDATE` on this column at runtime with an error. *(Section 3.5: "An `UPDATE velve.session SET user_id` does not exist and is prevented by a lint rule and a database trigger")*
- **S-FIX-3:** After each of the events named in S-FIX-1, a request with the previous token delivers the same response as a request without a cookie, and `SELECT count(*) FROM velve.session WHERE token_sha256 = sha256($alt)` yields 0. *(Section 3.5, revocation and re-issue)*
- **S-FIX-4:** The state between a correct password and the second factor is not a row in `velve.session` but a row in `velve.pending_authentication` with its own token in its own cookie. *(Section 3.6, first paragraph)*
- **S-FIX-5:** The session cookie carries in every response the name `__Host-velve_session`, no `Domain` attribute and `Path=/`; the server never sets more than one `Set-Cookie` header entry for the session cookie in one response. *(Section 3.5, cookie paragraph)*
- **S-FIX-6:** Password reset and password change revoke all other sessions of the user; there is no configuration option that switches this behaviour off. *(Section 3.5: "That is not a switch.")*

---

### 5.3 ENUM — User enumeration

**(a) The error class.** An enumeration oracle is any observable quantity that distinguishes between "account exists" and "account does not exist": status code, error code, `Content-Length`, a `Set-Cookie` in only one case, a `Retry-After` in only one case, the response time, or the side effect "an email goes out only for an existing account". Two are most often overlooked: the account-based rate counter that only triggers for existing accounts, and the email change that answers with "address already taken".

**(b) The precedent.** Better Auth's `/forget-password` is exemplarily uniform (`packages/better-auth/src/api/routes/password.ts:114-118` and `:331-333`). In the same project `/sign-in/email` with `requireEmailVerification` enabled delivers **403 `EMAIL_NOT_VERIFIED`** for existing, unconfirmed accounts and otherwise **401 `INVALID_EMAIL_OR_PASSWORD`** (`packages/better-auth/src/api/routes/sign-in.ts:569-597`) — a fully functional oracle that moreover takes effect only after the password verify. In addition, `packages/better-auth/src/api/routes/sign-up.ts:331` still throws `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`, although the same endpoint documents an opaque success response elsewhere (`sign-up.ts:249`).

**(c) The requirements.**

- **S-ENUM-1:** `POST /sign-in/password` delivers for an existing and a non-existing identifier with a wrong password identical HTTP status, an identical set of headers (after removing `Date`) and byte-identical response bodies. *(Section 3.13: "byte-identical responses — same status, same headers, same body")*
- **S-ENUM-2:** `POST /sign-in/password` delivers for the account states *not present*, *present and unconfirmed*, *present and confirmed*, *present and disabled*, *present without a `password_credential`* with a wrong password the same response; a disabled account delivers this response with a correct password as well, and the code `account_disabled` appears at no sign-in but only at the resolution of an existing session. *(Section 3.16, L-4; section 3.13; section 3.3 step 4: "a uniform response, no hint at the cause")*
- **S-ENUM-3:** `POST /sign-up` delivers for an already taken and a free email identical HTTP status, identical headers and byte-identical response bodies. *(Section 3.13, paragraph "Registration with an already taken email")*
- **S-ENUM-4:** On `POST /sign-up` with an already taken email the core sends exactly one message to the existing address, containing a sign-in link instead of a confirmation link; the number of messages sent is the same in both cases. *(Section 3.13: "a message goes to the existing address … with a sign-in instead of a confirmation link")*
- **S-ENUM-5:** `POST /password/request-reset` and `POST /email/request-change` deliver byte-identical responses for existing and non-existing target addresses; a collision on the email change is recognised only when the token is redeemed and is discarded there with the same response as an invalid token (`invalid_token`). *(Section 3.13, enumeration of the four uniform flows; section 3.15 F.1, inner cause `email_taken_on_change`)*
- **S-ENUM-6:** The true error reason is logged server-side on every rejected sign-in attempt, and the difference between the logged and the delivered reason arises at exactly one place in the source. *(Section 3.13, last paragraph)*
- **S-ENUM-7:** In the configuration `identity: "email"` there is no endpoint that returns the existence of an email address as a boolean answer. *(Section 3.4, column "Enumeration protection": "complete")*
- **S-ENUM-8:** In the configurations `username` and `username_email`, `GET /username/available` returns exclusively `available` and the rejection reason, is subject to its own bucket per IP prefix of 10 requests per minute and offers no prefix or similarity search; the documentation states the enumerability of usernames explicitly. *(Section 3.4: "Velve Auth offers it, limits it hard and says so in the documentation"; section 3.15 B.5)*

---

### 5.4 REPLAY — Replay

**(a) The error class.** An artefact is replayable when its validity follows from its content alone instead of from mutable server state. Signed links (JWT with `exp`) are the standard case: they land in mail archives, browser histories, and are called pre-emptively by corporate mail gateways. For TOTP, RFC 6238 §5.2 explicitly demands that a successfully used code be rejected for the rest of its time step — otherwise a phishing proxy redeems the same code a second time in parallel.

**(b) The precedent.** GHSA-wxw3-q3m9-c3jr (5.3 Moderate, fix 1.6.2): the cookie branch of `parseGenericState` never compared the stored nonce with the incoming `state` parameter. GHSA-pw9m-5jxm-xr6h / CVE-2026-53512 (**CVSS 9.1 Critical**, fix 1.6.11): `client_secret` was enforced only in the authorization code grant, not in the refresh grant — refresh token replay without client authentication.

**(c) The requirements.**

- **S-REPLAY-1:** Every single-use artefact of the library is a database row with `sha256(token)` as the primary key, a `purpose` and an `expires_at`; no single-use artefact is a self-contained signed string. *(Section 3.7, first sentence; schema `velve.one_time_token`)*
- **S-REPLAY-2:** The redemption of a one-time token is made exclusively through `DELETE FROM velve.one_time_token WHERE token_sha256 = $1 AND purpose = $2 AND expires_at > now() RETURNING user_id, payload`; an empty result set is the only invalidity signal. *(Section 3.7, SQL block)*
- **S-REPLAY-3:** The response to an expired, an already used and a never existing token is byte-identical in all three cases. *(Section 3.7: "expired, used and never existed are indistinguishable from the outside")*
- **S-REPLAY-4:** A TOTP code is accepted at most once per user and time step; the check is an `INSERT INTO velve.totp_used_step (user_id, time_step, expires_at)` whose failure on the primary key constraint is the rejection, and what is entered is the time step that actually matched, not the current one. *(Section 3.6, TOTP paragraph: "an `INSERT` that fails on conflict is the check")*
- **S-REPLAY-5:** A WebAuthn challenge is valid for at most 5 minutes, is consumed by `DELETE … RETURNING` and is accepted only for the purpose under which it was created (`register` or `authenticate`). *(Section 3.6, WebAuthn paragraph)*
- **S-REPLAY-6:** An OAuth callback is accepted only if the associated row in `velve.oauth_flow` still exists at consumption and has not expired; PKCE with `code_challenge_method = S256` is mandatory and cannot be switched off by any configuration, and with OIDC the `nonce` and the `iss` per RFC 9207 are checked in addition. *(Section 3.10, first paragraph)*

---

### 5.5 RAND — Insecure randomness

**(a) The error class.** Three patterns: the wrong source (`Math.random` is xorshift128+, reconstructible from five outputs; UUIDv7 is a good database key and a forbidden secret), too little entropy (not in the session token but in the short side artefact — reset token, recovery code, `state`), and entropy loss in the encoding through modulo bias when the alphabet length does not divide 256.

**(b) The precedent.** Better Auth uses a 64-character alphabet and is thereby bias-free, but chooses the length per call site: session token `generateId(32)` = 192 bit (`packages/better-auth/src/db/internal-adapter.ts:513`), reset token `generateId(24)` = 144 bit (`packages/better-auth/src/api/routes/password.ts:109,126`). `Math.random()` appears at three production sites (`packages/better-auth/src/client/session-refresh.ts:96`, `packages/core/src/db/adapter/factory.ts:61`, `packages/passkey/src/client.ts:107,237`) — none of them is a secret, but there is no rule that prevents the next use.

**(c) The requirements.**

- **S-RAND-1:** Every secret random value of the library comes from `crypto.getRandomValues`; `Math.random`, `Date.now` and counter values are used nowhere to generate a secret. *(Section 2.7, row "CSPRNG")*
- **S-RAND-2:** A session token consists of 32 bytes from `crypto.getRandomValues` and is encoded as base64url without a modulo mapping. *(Section 3.5, first enumeration point)*
- **S-RAND-3:** A recovery code carries 160 bits of entropy; the ten codes of a user are pairwise distinct. *(Section 3.6, recovery codes)*
- **S-RAND-4:** One-time tokens, OAuth `state`, PKCE verifiers and WebAuthn challenges each carry at least 256 bits of entropy from the same source as the session token. *(Section 3.5, token generation; section 3.10, PKCE obligation)*
- **S-RAND-5:** The generation of secrets is encapsulated in exactly one module; no other module calls the CSPRNG interface directly. *(Section 3.1, module cut `core/token/`)*
- **S-RAND-6:** Database keys (`uuid` columns with `gen_random_uuid()`) are separated from secrets in the type system; a value of type `EntityId` is not usable as a token without an explicit conversion and is never delivered in a cookie. *(Section 3.2, schema: `id uuid … DEFAULT gen_random_uuid()` as against `token_sha256 bytea`)*

---

### 5.6 TOKEN — Token reuse and single use

**(a) The error class.** Class REPLAY asks "can the same token take effect twice?", this class asks "is the token responsible for exactly one thing?". Three variants: purpose confusion (an email confirmation token is accepted at the reset endpoint because both query the same verification table without a purpose predicate), missing subject binding (a token for user A is redeemed in the session of user B) and incomplete revocation ("sign out everywhere" forgets a table).

**(b) The precedent.** GHSA-2vg6-77g8-24mp (3.8 Low, CWE-613/672/459, fix 1.6.11): four call sites deleted the user without first running `deleteSessions(userId)` in the `secondaryStorage` — tokens stayed valid for up to 7 days. GHSA-392p-2q2v-4372 / CVE-2026-53517 (7.6 High): the `adapter.update` predicate was keyed only on `id`, not additionally on `revoked IS NULL`, so that the refresh token family forked instead of being revoked.

**(c) The requirements.**

- **S-TOKEN-1:** Every query on `velve.one_time_token` contains `purpose` in the `WHERE` predicate; the repository signature demands the token hash and the purpose together, so that a query without a purpose does not compile. *(Section 3.7, SQL block; section 3.1, module `core/token/`)*
- **S-TOKEN-2:** A token with purpose *i* is rejected at an endpoint that redeems purpose *j ≠ i* with the same response as a freely invented token. *(Section 3.7, `purpose` column; section 3.13, "Deliberately invisible")*
- **S-TOKEN-3:** A newly requested one-time token of the same purpose deletes all previous tokens of the same purpose of the same user in the same transaction. *(Section 3.7, last sentence)*
- **S-TOKEN-4:** When a one-time token is applied to an account — email confirmation, email change, password reset —, the target account is exclusively `one_time_token.user_id`; no input field and no session sent along determines the target account. When an identity is linked, the target account is exclusively `oauth_flow.link_to_user_id`, which was set from the session at the start. *(Section 3.7, column `user_id`; section 3.15 B.7: "`velve.oauth_flow` already knows through `link_to_user_id` whether it links or signs in")*
- **S-TOKEN-5:** Deleting a user removes through `ON DELETE CASCADE` all rows in the thirteen user-bound tables `session`, `password_credential`, `identity`, `one_time_token`, `pending_authentication`, `totp_credential`, `totp_used_step`, `recovery_code`, `webauthn_credential`, `webauthn_challenge`, `oauth_flow` (`link_to_user_id`), `import_mapping` and `password_reset_required`; after the deletion none of these tables contains a row with the user id. *(Sections 3.2 and 3.17, schema: `REFERENCES velve.user(id) ON DELETE CASCADE` at every user-bound table)*
- **S-TOKEN-6:** Every table in the schema `velve` with a column that references `velve.user(id)` — including those created by plugins with the prefix `<plugin-id>_` — carries there a foreign key constraint with `ON DELETE CASCADE`; the migration runner rejects a migration that creates such a table without this constraint. *(Section 3.11, "Own tables in the schema `velve` with prefix `<plugin-id>_`; migrations run in the same versioned runner")*

---

### 5.7 RATE — Rate limiting

**(a) The error class.** A rate limiter consists of a key, a counter, a window and a reaction, and every part can be broken. The key faults dominate: the full IPv6 address instead of the prefix gives an attacker with a `/64` sixty-two-digit numbers of buckets; the textual representation of the same address yields several buckets; an unchecked `X-Forwarded-For` lets the client choose its bucket itself; and a raw path as a key component separates `//sign-in` from `/sign-in`. A hard account lock is not a protection but a denial of service against a known user.

**(b) The precedent.** GHSA-p6v2-xcpg-h6xw / CVE-2026-45364 (7.3 High, CWE-307, fix 1.4.17): the key was the textual IP without normalisation, so that a client with a `/64` prefix could create 2^64 buckets. GHSA-x732-6j76-qmhm (8.6 High, fix 1.4.5): the `rou3` router collapses empty path segments, so that `//sign-in/email` hits the same route but runs past path rate limits.

**(c) The requirements.**

- **S-RATE-1:** The IP rate key is the `/64` prefix for IPv6 and the full address for IPv4; different spellings of the same address — compressed, expanded, upper-case, IPv4-mapped-in-IPv6 — yield the same key. *(Section 3.9, first enumeration point)*
- **S-RATE-2:** 1000 requests from 1000 different addresses of the same `/64` share one bucket. *(Section 3.9: "the prefix, not the address, otherwise an attacker rotates at will (CVE-2026-45364)")*
- **S-RATE-3:** `X-Forwarded-For` is evaluated only if `trustedProxies` is configured; if the list is empty, only the connection address counts and every `X-Forwarded-*` header entry remains without effect on the key. *(Section 3.9: "`X-Forwarded-For` is evaluated only if `trustedProxies` is configured")*
- **S-RATE-4:** If no client address can be determined, counting is against a shared bucket per route and the limit is enforced; the check is never skipped. *(Section 3.9, three counters; section 3.11, "The origin check and the rate limiting always come first")*
- **S-RATE-5:** The rate key contains the resolved route name from the route declaration, not the raw path; `//sign-in/password`, `/sign-in/password/`, `/sign-in/password` and `/sign-in/passw%6Frd` count against the same bucket. *(Section 3.9, last paragraph; section 3.12, "Every route is declared once")*
- **S-RATE-6:** The counter is advanced in a single database statement (`INSERT … ON CONFLICT … DO UPDATE … RETURNING tokens`); with *n* simultaneous requests against a limit *L* at most *L* are accepted. *(Section 3.9, SQL block: "one round trip")*
- **S-RATE-7:** The key of the account-related counter is `HMAC(token-pepper, normalised identifier)`, not the account id; it is formed before the user is resolved, so that existing and non-existing accounts advance the same row and the identifier does not stand in cleartext in `velve.rate_bucket`. An empty bucket leads to a rejection with `rate_limited`, never to an artificial delay and never to a lock; the bucket refills at the configured rate, and after arbitrarily many failed attempts by third parties an account remains reachable for the rightful owner with correct credentials. *(Section 3.16, L-5; section 3.9: "a bucket with a slowly refilling rate instead of a lock … A lock is a denial of service against a known user.")*
- **S-RATE-8:** The counter per route and instance triggers on overrun exclusively the alarm callback and rejects no request. *(Section 3.9, third enumeration point)*

---

### 5.8 COOKIE — Cookie attributes

**(a) The error class.** `Domain=.example.com` sends the session token to *every* subdomain — including one whose DNS points at a foreign service — and does so without XSS and despite `HttpOnly`. Conversely, every subdomain can set a cookie of the same name (cookie tossing); the server then sees `name=A; name=B` without a distinguishing feature and as a rule takes the first, whose order the attacker controls through the path length. The `__Host-` prefix is the only measure that structurally excludes both, because the browser enforces it and not the application code.

**(b) The precedent.** Better Auth never sets `__Host-` (`packages/better-auth/src/cookies/index.ts:75` uses exclusively `__Secure-`), silently degrades `secure` to `false` when the derivation falls back to `isProduction` and `NODE_ENV` is not set in a container (`:65-74`), and overwrites the defaults unfiltered by a spread from `defaultCookieAttributes` (`:109-111`) — `httpOnly: false` is configurable without a warning.

**(c) The requirements.**

- **S-COOKIE-1:** The session cookie is named `__Host-velve_session` and carries `HttpOnly`, `Secure`, `SameSite=Lax` and `Path=/`. *(Section 3.5, cookie paragraph)*
- **S-COOKIE-2:** There is no configuration option that switches off `HttpOnly` or `Secure` on the session cookie or adds a `Domain` attribute to it. *(Section 3.5: "The `__Host-` prefix enforces `Secure` and forbids `Domain`")*
- **S-COOKIE-3:** The pending-state cookie is named `__Host-velve_pending`, has a lifetime of 5 minutes and carries the same attribute set as the session cookie. *(Section 3.6, first paragraph)*
- **S-COOKIE-4:** The session cookie contains exclusively the session token; it carries no user data, no session state and no cached check result. *(Section 3.5: "No cookie cache in the core")*
- **S-COOKIE-5:** If a request arrives with two cookies of the same name, it is rejected instead of one of the two being selected. *(Section 3.5, "Cookie tossing from a subdomain is thereby excluded" — the rejection covers the remaining case in which a client violates the browser rule)*
- **S-COOKIE-6:** The set of all cookies the library ever sets is enumerated in the source; a response that sets a cookie not enumerated is a fault. *(Section 3.12, "Every route is declared once"; section 3.11, "The extension points are enumerated, not open")*

---

### 5.9 CSRF — Cross-Site Request Forgery

**(a) The error class.** `SameSite=Lax` has four holes: state-changing GETs remain permitted (this affects the OAuth callback by protocol); a cookie without an explicit `SameSite` attribute is sent by Chrome for up to two minutes after being set even on a top-level POST; "same-site" is not "same-origin", so that any controlled subdomain bypasses `SameSite` completely; and against login CSRF it does not help at all. The `Origin` header is the load-bearing check, because the browser sets it and JavaScript cannot forge it.

**(b) The precedent.** GHSA-36rg-gfq2-3h56 / CVE-2025-53535 (2.1 Low): `matchesPattern` used `url.startsWith(pattern)`, so that `https://trusted.example.evil.com` counted as trustworthy. GHSA-vp58-j275-797x (7.1 High): faulty origin logic with absolute URLs and wildcard patterns permitted a `callbackURL` that exfiltrated the reset token. Both are prefix comparison faults on strings instead of equality comparisons on parsed origins.

**(c) The requirements.**

- **S-CSRF-1:** Every route except `GET /sign-in/oauth/callback/:provider` carries `originCheck: "checked"` and runs through the origin check before the handler runs; this holds also for the direct server call through the server method generated from the route declaration. *(Section 3.15 D.3: "The OAuth callback is the only route without an origin check"; section 3.11: "The origin check and the rate limiting always come first — for direct server calls too.")*
- **S-CSRF-2:** The origin check compares `new URL(header).origin` by string equality against an entry from `origins`; the library contains no prefix, substring or pattern matching on origins. *(Section 3.12, `origins: ["https://app.example.com"]`)*
- **S-CSRF-3:** An origin that differs from the permitted one only in the scheme, the port, a prefix or a suffix is rejected with `origin_not_allowed`; the rejection is byte-identical for all failure variants. *(Section 3.12, `origins`; section 3.15 F, `origin_not_allowed`)*
- **S-CSRF-4:** No state-changing operation is reachable through `GET`; the only exception is the OAuth callback, which is instead protected by `state`, PKCE and `iss`, and the remaining `GET` routes (`/session`, `/session/list`, `/username/available`, `/factor/webauthn/list`, `/factor/recovery/remaining`, `/identity/list`, `/pending`) are reading. *(Section 3.10, first paragraph; section 3.15 D.3, route table)*
- **S-CSRF-5:** The OAuth `state` lies server-side in `velve.oauth_flow`; the cookie holds only the pointer to it, and a callback with a valid `state` but a missing or foreign pointer cookie is rejected. *(Section 3.10: "`state` server-side in `velve.oauth_flow` (the cookie holds only the pointer)")*
- **S-CSRF-6:** A plugin can neither replace nor bypass the origin check nor be executed before it. *(Section 3.11, "What a plugin may not do", points 3 and 6)*

---

### 5.10 OWNER — Missing owner binding / IDOR

**(a) The error class.** An endpoint takes an object identifier from the request and operates on it without checking whether the object belongs to the user of the session. In credential management the effect is especially severe: deleting foreign factors is a lockout attack, creating foreign factors is an account takeover. Three details aggravate it: different responses for "does not exist" and "does not belong to you" deliver an additional oracle; the check as an `if` in the application code instead of as a predicate in the `WHERE` can be lost at the next refactoring; and an authorisation parameter that the middleware reads from one source and the handler from another is a confused deputy.

With **10 of 33 advisories** this class is the most frequent cause at Better Auth. It is not a cryptographic weakness but a missing line `AND user_id = $2`. The research report puts the consequence like this: the owner binding must be enforced architecturally, not by review. The target architecture implements this in one place — section 3.11, "What a plugin may not do": "Write to core tables directly. Only repository methods, and each one demands an `actor`." The following requirements draw the consequences of this for the core itself.

**(b) The precedents.** Ten advisories, one cause:

| GHSA | CVE | CVSS | Core of the fault |
|---|---|---|---|
| GHSA-99h5-pjcv-gr6v | CVE-2025-61928 | 8.6 High | Without a session the endpoint filled the user context from the request body |
| GHSA-4vcf-q4xf-f48m | — | 7.1 High | `/passkey/delete-passkey` trusted the passkey ID from the body without an owner check |
| GHSA-wmjr-v86c-m9jj | — | 2.0 Low | Multi-session sign-out passed raw cookie values unchecked to `deleteSessions` |
| GHSA-xr8f-h2gw-9xh6 | CVE-2026-41427 | 8.4 High, CWE-863 | The authorisation hook ran on read/update/delete, not before creation |
| GHSA-cq3f-vc6p-68fh | CVE-2026-45337 | 7.6 High | Every authenticated session counted as the owner of every open device code |
| GHSA-gv74-j8m3-fg5f | CVE-2026-53515 | 7.1 High | Read/update/delete demanded admin rights, registration only membership |
| GHSA-j8v8-g9cx-5qf4 | — | 8.3 High | `providerOwnership` off by default, `scimProvider.userId` stayed empty |
| GHSA-h3rm-78g3-j7cp | — | 7.1 High | Middleware checked the org ID from the query string or the body, the handler read only the body |
| GHSA-rjg6-39jm-rgg4 | — | **9.9 Critical** | A SCIM provider ID was allowed to collide with an existing provider ID |
| GHSA-prpr-5gj3-qqhg | — | 8.1 High | Orphaned account links after deletion of the provider |

The research report records: "**every single one** would have been prevented by the actor obligation in the repository."

**(c) The requirements.**

- **S-OWNER-1:** Every repository method that accesses a table with a `user_id` column takes an `actor`; there is no method on these tables without this parameter. *(Section 3.11: "Only repository methods, and each one demands an `actor`.")*
- **S-OWNER-2:** The owner condition stands in the SQL predicate, not in a branch of the TypeScript code: deleting and changing user-bound objects is done as `… WHERE id = $1 AND user_id = $2 RETURNING …`, and an empty result set is the rejection. *(Section 3.2, "No query abstraction. All SQL is hand-written for PostgreSQL."; section 3.11, actor obligation)*
- **S-OWNER-3:** `POST /factor/webauthn/remove` deletes a credential record only if `webauthn_credential.user_id` matches the `user_id` of the calling session; for a foreign and for an invented `credentialId` the response is byte-identical. *(Section 3.2, `velve.webauthn_credential.user_id`; section 3.15 B.6, `webauthn.remove`; section 3.11, actor obligation)*
- **S-OWNER-4:** `POST /session/revoke` acts only on rows with the `user_id` of the calling session; a foreign or invented `targetSessionId` changes no row, and the response is 204 in both cases. *(Section 3.5, "Revocation: individually, all but the current, all"; section 3.15 B.2 and F.1)*
- **S-OWNER-5:** Unlinking an identity acts only on rows in `velve.identity` with the `user_id` of the calling session. *(Section 3.2, `identity_user_id_idx`; section 3.10, explicit linking in an existing session)*
- **S-OWNER-6:** Every authorisation-relevant parameter is read from the request at exactly one place; if a request carries the same parameter with contradictory values in the query and the body, it is rejected instead of one of the values being chosen. *(Section 3.12, "Every route is declared once — path, method, input schema")*
- **S-OWNER-7:** The identity of the caller comes exclusively from the resolved session; no handler reads a user id from the request body, from a query or from a header entry in order to derive an actor from it. *(Section 3.5, resolution by one query on `token_sha256`)*
- **S-OWNER-8:** "Does not exist" and "belongs to another user" produce the same response with the same status, the same headers and the same body. *(Section 3.13, "Deliberately invisible: everything that would betray existence")*
- **S-OWNER-9:** Object identifiers of user-bound rows are `uuid` values from `gen_random_uuid()`; there is no sequential integer identifier on a user-bound table. *(Section 3.2, schema: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`)*
- **S-OWNER-10:** A plugin receives no write access to core tables except through the repository methods with the actor obligation, and the core context handed to it is frozen. *(Section 3.11, "Change the core context. The context is frozen (`Object.freeze`).")*
- **S-OWNER-11:** A plugin cannot override a core route; a name conflict between a plugin route and a core route leads to an error at start. *(Section 3.11: "A name conflict is a start error, not a warning.")*
- **S-OWNER-12:** A plugin hook can reject or observe an operation, but cannot replace the core's response and cannot exchange the session resolution. *(Section 3.11, "A hook may reject … or observe. It may not replace the response."; "Replace the password verifier, the session resolution or the origin check." under "What a plugin may not do")*

---

### 5.11 LINK — Account takeover through identity linking

**(a) The error class.** The email address is used as the connecting key between two identity spaces (local account ↔ provider identity). For that to hold, *both* sides would have to have verified the address; typically only one is checked — or neither. The attacker registers an account in advance on the victim's address, leaves it unverified, and when the victim later signs in via the provider, the pre-registered account together with the attacker's stored password is verified and taken over.

**(b) The precedent.** GHSA-g38m-r43w-p2q7 / CVE-2026-53516 (**8.3 High**, CWE-287/345, fix 1.6.11): "The auto-link gate validates only the OAuth provider's `userInfo.emailVerified` claim. The local row's `emailVerified` field is never read." GHSA-qq9h-g4jm-xgf3 (8.3 High, fix 1.6.22): magic link and email OTP login verified the existing account but did not remove the password the attacker had set before the verification. GHSA-fmh4-wcc4-5jm3 / CVE-2026-53514 (7.7 High) is the same cause with invitations. Three advisories, one cause.

**(c) The requirements.**

- **S-LINK-1:** The only linking key between a provider identity and a local account is the pair `(provider, subject)`; the email address is an attribute and is used in no query as a linking key. *(Section 3.10: "`(provider, subject)` is the only key. The email is never a linking key."; schema constraint `identity_provider_subject UNIQUE (provider, subject)`)*
- **S-LINK-2:** An automatic link with an existing account takes place only if the provider reports the email as verified **and** the local account carries `email_verified_at IS NOT NULL` **and** the provider stands in `trustedProviders`; if one of the three conditions is missing, a new account comes into being or it remains an explicit link in an existing session. *(Section 3.10, linking rule, conditions 1–3)*
- **S-LINK-3:** `velve.identity.subject` contains the stable provider id and never an email address. *(Section 3.2, schema: `subject text NOT NULL, -- the stable ID at the provider, never the email`)*
- **S-LINK-4:** If an email address is confirmed for the first time — by magic link or confirmation link — and the existing password was set in a session other than the confirming one, then the password sign-in is deleted and all existing sessions are revoked; if the password was set in the same session that is now confirming, it remains. A magic link links no provider identity. *(Section 3.16, L-12; section 3.10: "The email is never a linking key")*
- **S-LINK-5:** If a provider reports no email address, `velve.user.email` remains NULL in the configurations `username` and `username_email`; the library generates no placeholder address. *(Section 3.10, "No account without an email obligation")*
- **S-LINK-6:** The state `provider_email_verified` is stored per identity and updated at every sign-in from the provider claims; the value of one identity does not carry over to another identity of the same user. *(Section 3.2, schema: `provider_email_verified boolean NOT NULL DEFAULT false` on `velve.identity`)*
- **S-LINK-7:** Linking a further identity with an existing account is a change of trust level and therefore creates a new session row with a new token. *(Section 3.5: "Re-issue at every event that changes the trust level: … linking of a new identity")*

---

### 5.12 CACHE — Authorisation decision from a cache

**(a) The error class.** A cache stores the *result* of a check. If the entry is written before all conditions are fulfilled, the cache hit decides instead of the check. There are two windows: writing too early (the session is stored after the password step but before the second factor) and invalidating too late (an account deactivation takes effect only after the cache lifetime has expired). The HTTP variant is cache deception: an authenticated response is delivered under a path that looks cacheable.

**(b) The precedent.** GHSA-xg6x-h9c9-2m83 (**CVSS 9.1 Critical**, CWE-288, fix 1.4.9) — the most severe published fault in the core sign-in path, two advisories in peripheral packages are higher at 9.9 and 9.6: "Sessions generated during initial sign-in are prematurely cached as valid before 2FA verification." The cookie cache (`sessionData`, default lifetime 300 s, `packages/better-auth/src/cookies/index.ts:125-127`) remained in place as a feature; the fix closed only the write window. GHSA-hq75-xg7r-rx6c (`better-call`, Moderate) is the HTTP cache variant through a routing fault.

**(c) The requirements.**

- **S-CACHE-1:** The core answers the question "who is signed in" on every request with a database query; there is no cookie cache, no process cache and no external cache for sessions or session data, and every HTTP response carries `Cache-Control: no-store` and `Vary: Cookie`, so that no upstream HTTP cache reuses a response either. *(Section 3.5: "No cookie cache in the core. Authorisation decisions are never answered from a cache"; section 3.16, L-6)*
- **S-CACHE-2:** The session resolution is exactly one query with a join on `velve.user`, filtered by `token_sha256 = $1 AND idle_expires_at > now() AND absolute_expires_at > now()`, where `u.disabled_at` is read in the same query and, if set, yields `account_disabled` instead of a session (L-4); each of these four conditions takes effect on every request. *(Section 3.5, resolution paragraph)*
- **S-CACHE-3:** An account deactivation (`disabled_at`) takes effect on the next request of every existing session, without a lifetime having to be waited out. *(Section 3.5: "`u.disabled_at` is read in the same query"; section 3.16, L-4)*
- **S-CACHE-4:** The pending state from `velve.pending_authentication` is at no place converted into a session representation before the second factor has been checked; exactly the four routes with `caller: "pending"` — `POST /factor/totp/verify`, `POST /factor/webauthn/authenticate/start`, `POST /factor/webauthn/authenticate/finish`, `POST /factor/recovery/verify` — evaluate the pending-state cookie, every other route ignores it completely. *(Section 3.6; section 3.15 D.3: "only they read `__Host-velve_pending`, every other route ignores it completely")*
- **S-CACHE-5:** A plugin cannot introduce an intermediate layer that replaces the session resolution or caches its result. *(Section 3.11, "What a plugin may not do": "Replace the password verifier, the session resolution or the origin check.")*

---

### 5.13 REDIR — Open redirect and URL validation

**(a) The error class.** A URL string delivered by the client is taken over into a `Location` header entry after the completion of a flow. The check fails on parser differentials: `//evil.com` is protocol-relative, `/\evil.com` is read by browsers as a slash, `https://trusted.de.evil.com` passes a suffix test, `https://trusted.de@evil.com` hides the real host behind userinfo, and `javascript:` is not a navigation at all but script execution in its own origin. The damage is rarely the redirect itself but the `Referer`, which takes the token along.

**(b) The precedent.** Five advisories, the most productive source of faults in the project: GHSA-8jhw-6pjj-8723 / CVE-2024-56734 (7.9 High, `callbackURL` without domain validation), GHSA-hjpm-7mrm-26w8 / CVE-2025-27143 (6.9 Moderate, `https://evil.com` blocked, `//evil.com` not), GHSA-vp58-j275-797x (7.1 High, "craft a malicious link containing sensitive tokens (like password-reset tokens) to enable one-click account takeover"), GHSA-36rg-gfq2-3h56 / CVE-2025-53535 (2.1 Low, `startsWith`), GHSA-86j7-9j95-vpqj (7.7 High, CWE-79/601, `javascript:` as `redirect_uri`).

**(c) The requirements.**

- **S-REDIR-1:** The public interface takes as a redirect target exclusively a path, never a complete URL. *(Section 3.2, schema: `redirect_path text, -- a path, never a complete URL`)*
- **S-REDIR-2:** A redirect path that begins with `//` or `/\`, contains a scheme, a userinfo component or a host is rejected; the check takes place after exactly one percent decoding and is applied again afterwards. *(Section 3.2, `redirect_path`; section 3.1, module `core/http/`)*
- **S-REDIR-3:** The only `Location` header entry the library generates is the 302 response of the OAuth callback, and its value is the stored `redirect_path` — a path without a scheme and without a host; a `Location` value with a scheme, in particular `javascript:`, `data:`, `vbscript:` or `file:`, arises in no configuration. The provider's authorization URL is returned as `OAuthRedirect.authorizationUrl` in the response body, not as a redirect, and comes from the provider configuration (S-REDIR-6). *(Section 3.2, `redirect_path`; section 3.15 C and D.3: `OAuthRedirect`, callback with status 302)*
- **S-REDIR-4:** No `Location` header entry and no query string of a redirect generated by the library ever contains a one-time token, a session token or a PKCE verifier. *(Section 3.5, "The cleartext token leaves the process only in the cookie")*
- **S-REDIR-5:** Where an origin is checked, the check is an equality comparison on `new URL(x).origin` against the list `origins`; the library contains no pattern matching, no wildcard and no prefix comparison on origins. *(Section 3.12, `origins: ["https://app.example.com"]`)*
- **S-REDIR-6:** Provider endpoint URLs (authorization, token, JWKS, userinfo) come exclusively from the configuration at initialisation; no route registers or changes an endpoint URL that the server subsequently calls itself. *(Section 3.10, fixed provider list plus `genericOAuth`; section 3.12, initialisation)*
- **S-REDIR-7:** Every response of the library with a body carries the content type `application/json`; there is no HTML response and no response body that reflects an input value of the requester. *(Section 3.12, "Output type, error codes" per route; section 3.15 D.3, status codes per route)*

---

### 5.14 REST — Secrets at rest

**(a) The error class.** The decision follows one question: does the server have to get the value back in cleartext? No ⇒ hash. Yes ⇒ encrypt, with a key that does not lie in the database. The most frequent fault is to store session tokens in cleartext, "because you have to look them up after all" — but you do not look up the token, you look up its hash. For values with ≥ 128 bits of entropy, SHA-256 without salt suffices; for values of low entropy (passwords) a fast hash is wrong.

**(b) The precedent.** Better Auth stores session tokens in cleartext: `packages/better-auth/src/db/internal-adapter.ts:513` generates `token: generateId(32)` and stores it unchanged, the lookup runs on the cleartext column. Recovery codes lie as a JSON blob in *one* column (`packages/better-auth/src/plugins/two-factor/backup-codes/index.ts:78-99`), so that "using up a code" is a read-modify-write of the whole blob; without `storeBackupCodes` set, the blob is stored unencrypted (`:87`). TOTP secrets, by contrast, are encrypted correctly (`packages/better-auth/src/plugins/two-factor/index.ts:244-273`).

**(c) The requirements.**

- **S-REST-1:** A `pg_dump` of the schema `velve` contains no session token, no one-time token, no WebAuthn challenge, no recovery code, no TOTP secret, no PKCE verifier, no foreign OAuth token and no password in cleartext — neither as a character string nor in base64 or hex encoding. *(Section 3.2, storage rule: "Nothing confidential lies in cleartext in the database.")*
- **S-REST-2:** What the server only compares lies hashed: `session.token_sha256`, `one_time_token.token_sha256`, `pending_authentication.token_sha256`, `webauthn_challenge.challenge_sha256` and `oauth_flow.state_sha256` are `bytea` columns with SHA-256 values. *(Section 3.2, storage rule and schema)*
- **S-REST-3:** A recovery code is stored as `HMAC-SHA256(pepper, code)` under the purpose key `token-pepper`, with the key version in `recovery_code.key_version`; every code is its own row, and redemption is a `DELETE … RETURNING` on exactly this row. *(Section 3.6, recovery codes; section 3.16, L-3)*
- **S-REST-4:** What the server needs in cleartext lies AES-256-GCM encrypted: `totp_credential.secret_enc`, `oauth_flow.pkce_verifier_enc`, `identity.access_token_enc`, `identity.refresh_token_enc` and `identity.id_token_enc`. *(Section 3.2, storage rule; section 2.7, row "AES-256-GCM")*
- **S-REST-5:** A password lies exclusively as a canonical PHC string, and this lies in `password_credential.phc` (`bytea`) AES-256-GCM encrypted under the purpose `password-enc`, with the key version in `password_credential.key_version`; `scheme` stays cleartext. The library stores no foreign raw format and no reversible representation of a password. *(Section 3.3; section 3.16, L-2; section 3.17)*
- **S-REST-6:** Foreign OAuth tokens are stored only if the application explicitly demands it; the default is `storeTokens: false`. *(Section 3.10, last paragraph)*
- **S-REST-7:** If the library generates a password hash, the generated PHC string corresponds exactly to the configured parameters (default `m = 19456`, `t = 2`, `p = 1`, 32 bytes of output, 16 bytes of salt); a stored hash with weaker parameters or a non-standard scheme leads to a rehash at the next successful login. *(Section 3.3, default parameters and steps 5–6)*

---

### 5.15 KEY — Key management and rotation

**(a) The error class.** One secret for everything means: one leak compromises everything at the same time, rotation invalidates everything at the same time, and without domain separation a value generated in one context can pass as valid in another. Rotation without a transition window signs all users out; rotation without re-encryption makes the old key necessary forever. And with compromised *encryption* keys rotation is not enough — the protected secrets themselves must be generated anew.

**(b) The precedent.** Better Auth has implemented rotation (envelope `$ba$<version>$<ciphertext>`, `packages/better-auth/src/crypto/secret-rotation.test.ts`, `packages/better-auth/src/context/secret-utils.ts`), but the migration is incomplete: numerous call sites still use the single `ctx.context.secret` instead of `secretConfig` — among others `packages/better-auth/src/api/routes/session.ts:91,126,225`, `email-verification.ts:60,188,307,341,444`, `sign-out.ts:80`, `cookies/index.ts:220,231,315,335,366,379,391`, `two-factor/index.ts:415,460,470,493,512,561`. For everything that runs through `ctx.context.secret` the rotation is without effect; moreover the same root secret serves directly as an HMAC key and as an encryption key, without purpose-bound derivation. Related: GHSA-9h47-pqcx-hjr4 (8.7 High, CWE-327/757/1188) — the discovery document advertised `"none"` as a signature algorithm.

**(c) The requirements.**

- **S-KEY-1:** All working keys are derived by HKDF-SHA256 from a root key, with exactly one derivation context per purpose; the six purposes are `cookie-sig`, `token-pepper`, `totp-enc`, `oauth-token-enc`, `pkce-enc` and `password-enc`. *(Section 3.8, first paragraph; section 3.15 A.8, `KeyPurpose`; section 3.16, L-2)*
- **S-KEY-2:** A value produced under the key of one purpose is not verifiable and not decryptable with the key of another purpose. *(Section 3.8, purpose separation)*
- **S-KEY-3:** Every generated, protected value carries its key version with it — either in the envelope or in its own column (`totp_credential.key_version`, `oauth_flow.key_version`, `identity.token_key_version`, `password_credential.key_version`, `recovery_code.key_version`). *(Section 3.8: "Every generated value carries its key version in the envelope."; sections 3.2 and 3.17, schema)*
- **S-KEY-4:** The `KeyProvider` supplies through `current(purpose)` exactly one version for generating and through `byVersion(purpose, version)` every version of the ring for checking; a version no longer contained in the ring leads to `null` and thereby to a clearly named error instead of a generic crash. *(Section 3.8, `KeyProvider` interface)*
- **S-KEY-5:** A rotation of the root key ends no existing session: after a new version has been put in front and after the old version has been removed from the ring, all rows in `velve.session` remain valid. *(Section 3.8: "Because sessions are opaque database rows, every key rotation is survived by all sessions.")*
- **S-KEY-6:** The library does not start if the root key is missing or shorter than 32 bytes. *(Section 3.8, default implementation; section 3.12, `keys: keyProvider` as a mandatory field)*
- **S-KEY-7:** The check of the signature of an ID token accepts exclusively asymmetric algorithms from an enumerated list against the provider's JWKS; `none` and symmetric algorithms are rejected. *(Section 3.10: "ID token signature against JWKS"; section 2.7, `jose`)*

---

### 5.16 RACE — Concurrency when consuming single-use artefacts

**(a) The error class.** `SELECT` → check → `DELETE` is not atomic. Two parallel requests both pass the `SELECT` before the first completes the `DELETE`, and both count as valid. Affected are all single-use artefacts: reset token, magic link, email change, WebAuthn challenge, OAuth `state`, recovery code, TOTP time step. The only reliable countermeasure is to write the state condition as a predicate into the `WHERE` instead of into an `if` — plus uniqueness constraints as the last defence.

**(b) The precedent.** GHSA-7w99-5wm4-3g79 / CVE-2026-53518 (7.6 High, CWE-362/367/294): "the token endpoint used a non-atomic find-then-delete; two concurrent requests both passed the read." GHSA-392p-2q2v-4372 / CVE-2026-53517 (7.6 High): the `update` predicate was keyed only on `id`, not additionally on `revoked IS NULL`. GHSA-8c5h-wx78-2cfg (8.1 High, CWE-287/345/367/862) is the TOCTOU variant. Three advisories, the same cause, within a few months.

**(c) The requirements.**

- **S-RACE-1:** With 50 simultaneous redemption attempts of the same one-time token exactly one is successful. *(Section 3.7, `DELETE … RETURNING` as the only path of consumption)*
- **S-RACE-2:** Before a consumption there is no reading access to the same row; the validity conditions `purpose` and `expires_at > now()` stand in the `WHERE` of the same statement that removes the row. *(Section 3.7, SQL block)*
- **S-RACE-3:** With 50 simultaneous submissions of the same TOTP code of the same user exactly one is successful; the serialisation is performed by the primary key `(user_id, time_step)`. *(Section 3.6, TOTP paragraph)*
- **S-RACE-4:** With 50 simultaneous submissions of the same recovery code exactly one is successful; the serialisation is performed by the primary key `(user_id, code_hmac)` together with `DELETE … RETURNING`. *(Section 3.6, recovery codes; section 3.2, schema)*
- **S-RACE-5:** Session re-issue (`INSERT` new, `DELETE` old) and password change run in one transaction; a fault after the one and before the other step leaves neither of the two effects behind. *(Section 3.5, "in one transaction"; section 3.2, `Driver.transaction`)*
- **S-RACE-6:** The rehash after a successful sign-in writes by compare-and-swap (`… WHERE user_id = $1 AND phc = $alt`); if the swap fails, the existing hash stays unchanged and no error state arises. *(Section 3.3, step 6: "If that fails, nothing is broken")*

---

### 5.17 DEFAULT — Insecure default values

**(a) The error class.** Almost every "Critical" rating in the advisory history hangs on a default, not on a fault in the narrower sense: `alg=none` advertised, `providerOwnership` off, `cookieCache` before the second factor, `revokeSessionsOnPasswordReset` undefined. The mechanism is always the same: a security function is opt-in, so it is off in the overwhelming number of installations, and the author of the library learns of it only from the advisory.

**(b) The precedent.** GHSA-9h47-pqcx-hjr4 (8.7 High): a missing `code_challenge_method` was silently downgraded to `plain`. GHSA-j8v8-g9cx-5qf4 (8.3 High): `providerOwnership` was off by default. GHSA-fmh4-wcc4-5jm3 / CVE-2026-53514 (7.7 High): email verification is off by default, and the invitation endpoint treated string equality as proof of ownership regardless. And in `packages/better-auth/src/api/routes/password.ts:328` the reset path checks `options.emailAndPassword?.revokeSessionsOnPasswordReset`, which is declared in `packages/core/src/types/init-options.ts:860` as an optional field and is nowhere set to a value — so `undefined` and thereby false.

**(c) The requirements.**

- **S-DEFAULT-1:** Every security-relevant setting of the library is in its default position the secure one; a weakening requires an explicit statement in the configuration and is logged at start. *(Section 3.11, "The extension points are enumerated, not open"; section 3.10, `storeTokens: false` as the default; section 3.5, "That is not a switch.")*
- **S-DEFAULT-2:** The library contains no option that switches off the revocation of other sessions on a password change or a password reset. *(Section 3.5: "Password reset and password change revoke all other sessions by default. That is not a switch.")*
- **S-DEFAULT-3:** The library contains no option that deactivates PKCE, the state check, the origin check or the rate limiting. *(Section 3.10, "PKCE S256 mandatory"; section 3.11, "The origin check and the rate limiting always come first")*
- **S-DEFAULT-4:** The configuration `identity: "username"` without `recoveryCodes: true` leads to a start error. *(Section 3.4: "The library enforces that: `identity: "username"` without `recoveryCodes: true` is a start error.")*
- **S-DEFAULT-5:** A name conflict between two plugins or between a plugin and the core — route, table prefix or error code — leads to a start error and not to a warning. *(Section 3.11: "A name conflict is a start error, not a warning.")*
- **S-DEFAULT-6:** The default parameters for Argon2id are `m = 19456` KiB, `t = 2`, `p = 1` with 32 bytes of output and 16 bytes of salt and can be changed only upwards; a configuration with weaker parameters leads to a start error. *(Section 3.3: "Default parameters for Argon2id … Configurable upwards.")*
- **S-DEFAULT-7:** If the optional accelerator dependency `hash-wasm` is found, the Argon2id values it generates and checks are bit-identical with those of `@noble/hashes`; its presence or absence changes no security behaviour. *(Sections 2.1 and 2.7, `hash-wasm` as an optional peer dependency)*

---

### 5.18 DOS — Resource exhaustion through the KDF

**(a) The error class.** A memory-hard KDF is a weapon that points in both directions. Argon2id with `m = 19456` KiB occupies 19 MiB per call. Without a limit on concurrency, a sign-in flood multiplies this amount by the number of simultaneous requests, and the process dies of memory instead of rejecting requests. The second vector is the input length: a megabyte-sized "password" costs nothing before the KDF and everything in the KDF if the length is only checked afterwards. The third is the waiting case: without a wait limit, waiting requests pile up without bound.

**(b) The precedent.** For KDF exhaustion itself there is no advisory of its own in the Better Auth history. The related variant is GHSA-569q-mpph-wgww / CVE-2025-71401 (2.9 Low, fix 1.4.2): without `baseURL` set, the router trusted `X-Forwarded-Host`/`-Proto` on the first request and permanently poisoned the base path — a denial of service triggered by a single external request.

**(c) The requirements.**

- **S-DOS-1:** The input length is checked before every KDF call: a password under 8 characters and a password over 4096 bytes are rejected without a KDF call taking place. *(Section 3.3, course, step 1: "before every KDF call"; section 3.16, L-7)*
- **S-DOS-2:** The length check depends exclusively on the input and runs before the resolution of the user; a sign-in with a password that is too long or too short therefore delivers for an existing and a non-existing identifier byte-identically the same response in the same time and is no enumeration oracle. *(Section 3.16, L-1: "exactly one code path that performs the same work regardless of the outcome"; section 3.3 step 1)*
- **S-DOS-3:** The number of KDF calls running simultaneously in the process is limited by a semaphore to `min(4, cpus)`; the occupied memory therefore does not exceed the product of semaphore size and KDF memory parameter, independently of the number of simultaneous requests. *(Section 3.3, concurrency paragraph)*
- **S-DOS-4:** A request that has not obtained a semaphore place after 5 seconds is rejected with `rate_limited`; the wait limit applies equally to existing and non-existing accounts, and waiting requests produce no out-of-memory error and no crash. *(Section 3.16, L-1, wait limit; section 3.3, concurrency paragraph)*
- **S-DOS-5:** The rate limiting per IP prefix and route runs before the semaphore request, so that a flood is rejected before it occupies semaphore places. *(Section 3.11: "The origin check and the rate limiting always come first — for direct server calls too.")*
- **S-DOS-6:** The rehash in the background occupies the same semaphore as the verification path; a sign-in wave after a parameter increase displaces no running sign-ins. *(Section 3.3, step 6 "in a bounded background task" and the concurrency paragraph)*

---

### 5.19 Coverage table: the 33 Better Auth advisories

Every row names the advisory, its error class and the Velve Auth requirements that exclude this class — or the reason why the class cannot exist in Velve Auth. "Not applicable" means: the affected function is explicitly not part of the product per section 3.14. Where the function is missing but the *class* would nevertheless be structurally prevented by a requirement, this requirement is named in parentheses — it protects the plugins that could retrofit this function.

| # | GHSA | CVE / CVSS | Class | Velve Auth requirement |
|---|---|---|---|---|
| 1 | GHSA-8jhw-6pjj-8723 | CVE-2024-56734, 7.9 | Open redirect (`callbackURL`) | S-REDIR-1, S-REDIR-2, S-REDIR-4 |
| 2 | GHSA-9x4v-xfq5-m8x5 | —, 5.1 | Reflected XSS on `/api/auth/error` | S-REDIR-7 (JSON only, no reflection of input) |
| 3 | GHSA-hjpm-7mrm-26w8 | CVE-2025-27143, 6.9 | Protocol-relative URL `//evil.com` | S-REDIR-2, S-REDIR-5 |
| 4 | GHSA-vp58-j275-797x | —, 7.1 | Origin bypass → reset token leak | S-REDIR-4, S-REDIR-5, S-CSRF-2 |
| 5 | GHSA-36rg-gfq2-3h56 | CVE-2025-53535, 2.1 | `startsWith` in the origin comparison | S-CSRF-2, S-CSRF-3, S-REDIR-5 |
| 6 | GHSA-99h5-pjcv-gr6v | CVE-2025-61928, 8.6 | Unauthenticated API key creation | Not applicable, because Velve Auth has no API keys (section 3.14). The class is structurally prevented by S-OWNER-1, S-OWNER-7 |
| 7 | GHSA-4vcf-q4xf-f48m | —, 7.1 | Passkey deletion via IDOR | **S-OWNER-2, S-OWNER-3, S-OWNER-8** — directly applicable, Velve Auth has passkeys |
| 8 | GHSA-wmjr-v86c-m9jj | —, 2.0 | Unchecked cookie values on multi-session sign-out | Not applicable, because Velve Auth has no multi-session plugin. The class is prevented by S-OWNER-4, S-COOKIE-4 |
| 9 | GHSA-569q-mpph-wgww | CVE-2025-71401, 2.9 | `X-Forwarded-Host` poisons the base path | S-RATE-3, S-CSRF-2, S-DEFAULT-1 (origins are configured, not derived from headers) |
| 10 | GHSA-x732-6j76-qmhm | —, 8.6 | Double slash bypasses the rate limit | S-RATE-5 (key from the resolved route name) |
| 11 | GHSA-xg6x-h9c9-2m83 | —, **9.1** | 2FA bypass through the cookie cache | **S-CACHE-1, S-CACHE-2, S-CACHE-4, S-COOKIE-4, S-FIX-4** |
| 12 | GHSA-p6v2-xcpg-h6xw | CVE-2026-45364, 7.3 | Single IPv6 address as the rate key | **S-RATE-1, S-RATE-2** |
| 13 | GHSA-wxw3-q3m9-c3jr | —, 5.3 | `state` never compared in the cookie branch | S-CSRF-5, S-REPLAY-6 |
| 14 | GHSA-xr8f-h2gw-9xh6 | CVE-2026-41427, 8.4 | OAuth provider: hook skipped on create | Not applicable, because Velve Auth is not an OAuth server itself (section 3.14). The class is prevented by S-OWNER-1 |
| 15 | GHSA-cq3f-vc6p-68fh | CVE-2026-45337, 7.6 | Device grant without owner binding | Not applicable, because Velve Auth has no device authorization grant. The class is prevented by S-OWNER-2 |
| 16 | GHSA-g38m-r43w-p2q7 | CVE-2026-53516, 8.3 | Auto-link does not read the local `emailVerified` | **S-LINK-1, S-LINK-2, S-LINK-3** |
| 17 | GHSA-fmh4-wcc4-5jm3 | CVE-2026-53514, 7.7 | Invitation acceptance by email string equality | Not applicable, because Velve Auth has no organisations and no invitations (section 3.14). The class is prevented by S-LINK-1 |
| 18 | GHSA-5rr4-8452-hf4v | CVE-2026-53513, **9.6** | SSRF on SSO provider registration | Not applicable, because Velve Auth has no SSO/SAML and no provider registration at runtime (section 3.14). The class is prevented by S-REDIR-6 |
| 19 | GHSA-gv74-j8m3-fg5f | CVE-2026-53515, 7.1 | SSO registration without a role check | Not applicable, because Velve Auth has no SSO and no roles (section 3.14) |
| 20 | GHSA-pw9m-5jxm-xr6h | CVE-2026-53512, **9.1** | Refresh grant without client authentication | Not applicable, because Velve Auth issues no tokens but only accepts foreign ones (section 3.14) |
| 21 | GHSA-9h47-pqcx-hjr4 | —, 8.7 | `alg=none`, silent downgrade to `plain` PKCE | S-KEY-7 (algorithm allowlist), S-DEFAULT-3 (PKCE S256 not switchable off), S-REPLAY-6 |
| 22 | GHSA-7w99-5wm4-3g79 | CVE-2026-53518, 7.6 | Concurrent redemption of authorization codes | Not applicable as an OAuth server; the class hits Velve Auth's own single-use artefacts and is excluded by **S-RACE-1, S-RACE-2** |
| 23 | GHSA-392p-2q2v-4372 | CVE-2026-53517, 7.6 | Refresh family forks instead of being revoked | Not applicable, because Velve Auth issues no refresh token families. The class is prevented by S-RACE-2 (state condition in the `WHERE`) |
| 24 | GHSA-2vg6-77g8-24mp | —, 3.8 | Sessions survive the deletion of the user | **S-TOKEN-5, S-TOKEN-6** (`ON DELETE CASCADE` at every user-bound table, enforced by the migration runner) |
| 25 | GHSA-86j7-9j95-vpqj | —, 7.7 | `javascript:` as `redirect_uri` | Not applicable, because Velve Auth has no OAuth client registration. The class is prevented by S-REDIR-1, S-REDIR-3 |
| 26 | GHSA-p2fr-6hmx-4528 | —, 6.4 | Access token audience not bound to the grant | Not applicable, because Velve Auth issues no access tokens (section 3.14) |
| 27 | GHSA-j8v8-g9cx-5qf4 | —, 8.3 | SCIM: `providerOwnership` off by default | Not applicable, because Velve Auth has no SCIM (section 3.14). The class is prevented by S-OWNER-1, S-DEFAULT-1 |
| 28 | GHSA-h3rm-78g3-j7cp | —, 7.1 | Authorisation parameter from two sources | Not applicable, because Velve Auth has no Stripe module and no organisations (section 3.14). The class is prevented by **S-OWNER-6** |
| 29 | GHSA-prpr-5gj3-qqhg | —, 8.1 | SSO: parser differential, orphaned links, missing SAML checks, XSS | Not applicable, because Velve Auth has no SSO/SAML (section 3.14). The sub-class "orphaned links" is prevented by S-TOKEN-5; "parser differential" by S-REDIR-5, S-CSRF-2 |
| 30 | GHSA-rjg6-39jm-rgg4 | —, **9.9** | SCIM provider ID collides with an SSO provider ID | Not applicable, because Velve Auth has no SCIM (section 3.14). The class "namespace collision" is prevented by **S-DEFAULT-5** and S-OWNER-11 |
| 31 | GHSA-qq9h-g4jm-xgf3 | —, 8.3 | Magic link / email OTP: the pre-registered account keeps its password | **S-LINK-4** — directly applicable, Velve Auth has magic links (section 3.7); closed by L-12 |
| 32 | GHSA-8c5h-wx78-2cfg | —, 8.1 | SSO domain ownership: TOCTOU and missing verification | Not applicable, because Velve Auth has no domain verification (section 3.14). The TOCTOU class is prevented by S-RACE-2 |
| 33 | GHSA-hq75-xg7r-rx6c | —, 4.9 | `better-call` routing → cache deception | Not applicable, because Velve Auth uses no third-party router: the route is declared once and the handler is generated from it (section 3.12). The class is prevented by S-RATE-5, S-CACHE-1 and `Cache-Control: no-store` on every response (L-6) |

**Evaluation.** Of 33 advisories, **15 are directly transferable to Velve Auth** (#1–#5,
#7, #9–#13, #16, #21, #24, #31 — of these #9 and #21 only partly) and **18 are not
applicable, because the affected function does not exist per section 3.14**. Of the 18 not applicable ones, 15 would additionally be excluded by a structural requirement if a plugin retrofitted the function; the three remaining ones (#19, #20, #26) concern roles and token issuance, for which there is no counterpart in the core. The three requirements with the greatest leverage are S-OWNER-1 (the actor obligation, prevents the class with 10 advisories), S-RACE-2 together with S-REPLAY-2 (atomic consumption as the only path, prevents replay, race and purpose confusion) and S-LINK-1 (the email is not a key, prevents the class with the highest CVSS values).

---

### 5.20 The previously open points

While this section and the test plan were being elaborated, thirteen gaps in the target architecture became visible. They are **decided and closed** — the decisions stand in section 3.16 as L-1 to L-13 and are worked into the requirements above.

| Gap | Decided in |
|---|---|
| Wait limit instead of a response deadline | L-1 (takes effect on S-TIM-6, S-DOS-2, S-DOS-4) |
| No pepper for passwords | L-2 — envelope encryption instead, purpose `password-enc` (takes effect on S-REST-5, S-KEY-1, S-KEY-3) |
| `recovery_code` without a key version | L-3 (takes effect on S-REST-3, S-KEY-3) |
| A disabled account as an enumeration oracle | L-4 (takes effect on S-ENUM-2, S-CACHE-2, S-CACHE-3) |
| The key of the account-related counter | L-5 (takes effect on S-RATE-7) |
| Missing HTTP cache headers | L-6 (takes effect on S-CACHE-1) |
| No password lower bound, no leak check | L-7 (takes effect on S-DOS-1) |
| Attempt limit in the pending state | L-8 |
| Regressing `sign_count` | L-9, a documented deviation from WebAuthn Level 3 §7.2 |
| Full IP and user agent in `velve.session` | L-10 |
| No named sweep run (seven `*_sweep_idx`) | L-11 |
| Unverified pre-registered account (GHSA-qq9h-g4jm-xgf3) | L-12 (takes effect on S-LINK-4) |
| Removing the last sign-in path | L-13 |

---

## 6. Test plan

To each of the 123 requirements from section 5 belongs a test case. The test ID carries the same class and the same number as the requirement: `T-OWNER-3` verifies `S-OWNER-3`. In addition there are four supplementary test cases that are not assigned to a single requirement but secure a class more broadly (`T-TIM-1b`, `T-RAND-Verteilung`, `T-RAND-Kollision`, `T-CSRF-Parser`) — **127 test cases** together.

**Columns.** *Kind* is one of six: `Unit`, `Integration`, `Property` (fast-check), `Statistical`, `Concurrency`, `Static` (lint rule, AST analysis, type check); combinations are given with `+`. *Threshold* is a number or a hard criterion — no test in this plan passes with "no errors". *Runs in* is one of three tiers: `CI on every commit` (109 test cases, plus the static part of T-RACE-2), `CI nightly` (15, plus the concurrency part of T-RACE-2), `before every release` (2).

**Principle of the tier assignment.** Everything deterministic blocks every commit. Everything statistical and everything that runs longer than 60 seconds runs nightly on a dedicated runner and reports as a ticket, not as a red build. The reason is in section 6.20.

---

### 6.1 TIM — Timing attacks

| Test ID | verifies | Kind | Procedure | Threshold | runs in |
|---|---|---|---|---|---|
| T-TIM-1 | S-TIM-1 | Statistical | In-process server, real Postgres, production KDF parameters. Group X: 50 existing accounts. Group Y: 50 non-existent addresses of the same length and the same domain. n = 1000 per group, interleaved in random order, first 100 measurements discarded. Measured quantity `process.hrtime.bigint()` around the handler plus TTFB over a real socket. | Welch t-test on 10 % trimmed means: **\|t\| < 4.5**; additionally **Cliff's δ < 0.147** | CI nightly |
| T-TIM-1b | S-TIM-1 | Unit | Instrumented driver logs every DB and KDF call. Four cases: existing account + wrong password, non-existent account, existing account without `password_credential`, syntactically invalid email. | **4/4 call sequences byte-for-byte identical** | CI on every commit |
| T-TIM-2 | S-TIM-2 | Unit | Create a dummy PHC at process start, parse the PHC parameters and compare them against the configuration; check with a spy which verifier function is called in the dummy path. | `m/t/p/salt length` exactly equal; **the function called is `verify`, not `hash`** | CI on every commit |
| T-TIM-3 | S-TIM-3 | Static | `ts-morph` rule: in `src/core/**` every comparison operator and every comparison method (`===`, `!==`, `==`, `startsWith`, `includes`, `localeCompare`, `indexOf`) on a value of the branded type `Secret<…>` is forbidden. | **0 violations**, runtime < 5 s | CI on every commit |
| T-TIM-4 | S-TIM-4 | Static + Integration | AST scan: no SQL literal in the repository contains `token =` without `_sha256`. In addition an integration test that creates a session and searches every text column of the table with `SELECT` for the plaintext token. | **0 SQL hits; 0 column hits** | CI on every commit |
| T-TIM-5 | S-TIM-5 | Integration | Create an account with an outdated bcrypt hash, sign in, measure TTFB; the same with an account whose hash is already current. 200 measurements per group. | Difference of the medians **< 5 ms**; the rehash is visible in the database afterwards | CI nightly |
| T-TIM-6 | S-TIM-6 | Integration + Static | Instrumented driver and mail-sending double count queries and callback calls for `POST /password/request-reset` and `POST /sign-in/magic-link/request`, once each with an existing and a non-existent account; plus 200 measurements per case. Type check: the options type contains no key for a minimum response duration. | **2/2 endpoints: identical query sequence and exactly 1 callback call in both cases**; difference of the medians of the first response byte **< 5 ms**; `rate_bucket` contains **exactly 1 row** for the identifier after both cases; **0 option keys** | CI nightly |
| T-TIM-7 | S-TIM-7 | Unit | Instrumented driver, cases: confirmed and unconfirmed account, each with a wrong and with a correct password. Type check: the options type contains no key `requireEmailVerification`. | Wrong password: **call sequences identical**, response body byte-for-byte identical. Correct password: **2/2 sessions created**, the responses differ solely in `user.emailVerifiedAt`; **0 option keys** | CI on every commit |

---

### 6.2 FIX — Session fixation

| Test ID | verifies | Kind | Procedure | Threshold | runs in |
|---|---|---|---|---|---|
| T-FIX-1 | S-FIX-1 | Integration, table-driven | For every event of the constant `TRUST_LEVEL_EVENTS` (password sign-in, passkey sign-in, TOTP completion, WebAuthn-2F completion, recovery-code completion, password change, password reset, identity linking): note token T1, trigger the event, read T2. | `T2 ≠ T1` in **8/8**; the test fails if `TRUST_LEVEL_EVENTS.length ≠ number of test cases` | CI on every commit |
| T-FIX-2 | S-FIX-2 | Static + Integration | AST scan over all repositories: no `UPDATE` literal on `velve.session` with `user_id` in the SET part. In addition a direct `UPDATE velve.session SET user_id = …` through the driver against the test database. | **0 AST hits**; the database throws an exception, `SQLSTATE` is not `00000` | CI on every commit |
| T-FIX-3 | S-FIX-3 | Integration | After each of the 8 events from T-FIX-1, send a request with T1 and count the rows. | `SELECT count(*) … token_sha256 = sha256(T1)` = **0**; response with T1 **byte-for-byte identical** to the response without a cookie | CI on every commit |
| T-FIX-4 | S-FIX-4 | Integration | Sign in with the correct password while a second factor is active; then count the tables. | `velve.session` **+0 rows**, `velve.pending_authentication` **+1 row**; the response sets `__Host-velve_pending`, not `__Host-velve_session` | CI on every commit |
| T-FIX-5 | S-FIX-5 | Integration | Parse the `Set-Cookie` headers of every response that creates a session. | Exactly **1** entry with the session name; attribute set exactly `{HttpOnly, Secure, SameSite=Lax, Path=/}`; **no** `Domain` | CI on every commit |
| T-FIX-6 | S-FIX-6 | Integration + Static | Create three sessions A (the caller), B, C; change the password and reset it separately. In addition a type check: the options types contain no key that controls this revocation. | B and C return the "not signed in" response, A stays valid: **2/2 per event**; **0 option keys** | CI on every commit |

---

### 6.3 ENUM — User enumeration

| Test ID | verifies | Kind | Procedure | Threshold | runs in |
|---|---|---|---|---|---|
| T-ENUM-1 | S-ENUM-1 | Integration | Two `POST /sign-in/password` requests with identifiers of the same length, one existing, one not. Normalise the responses (remove `Date`). | `status_a === status_b`, sorted header names equal, `Buffer.compare(body_a, body_b) === 0` — **0 differing bytes** | CI on every commit |
| T-ENUM-2 | S-ENUM-2 | Integration, table-driven | Produce five account states, `POST /sign-in/password` with a wrong password for each; as the sixth case the disabled account with the correct password. | **6/6 responses byte-for-byte identical**; `account_disabled` occurs in **0** of the responses | CI on every commit |
| T-ENUM-3 | S-ENUM-3 | Integration | `POST /sign-up` with a taken and with a free email of the same length. | **0 differing bytes** in status, header set and body | CI on every commit |
| T-ENUM-4 | S-ENUM-4 | Integration | The mail-sending double counts messages and logs the template identifier. | Both cases **exactly 1 message**; template identifiers **different**; recipient address in the collision case the existing one | CI on every commit |
| T-ENUM-5 | S-ENUM-5 | Integration | `POST /password/request-reset` and `POST /email/request-change` twice each (existing / non-existent). For the email change, additionally redeem the token onto a colliding address. | **0 differing bytes** per endpoint; redeeming on a collision changes **0 rows** and returns byte-for-byte the response to an invented token (`invalid_token`) | CI on every commit |
| T-ENUM-6 | S-ENUM-6 | Integration + Static | Check the log sink: for each of the 6 cases from T-ENUM-2 the true reason must be in the log. AST scan: the mapping from inner reason to outer code exists in exactly one place (`core/http/error-map.ts`). | **6/6 reasons logged**; **exactly 1 mapping site** | CI on every commit |
| T-ENUM-7 | S-ENUM-7 | Static | List the route declaration for `identity: "email"` and check it against an allowlist. | **0 routes** whose response depends on the existence of an email | CI on every commit |
| T-ENUM-8 | S-ENUM-8 | Integration | `GET /username/available`: check the response shape; 11 requests within one minute from the same IP prefix; send a request with a prefix wildcard (`*`, `%`). | Body contains **exactly** the fields `available` and optionally `reason`; the **11th request** returns `rate_limited`; the wildcard request returns `available: false` with `reason: "invalid_characters"` and no hit list | CI on every commit |

---

### 6.4 REPLAY — Replay

| Test ID | verifies | Kind | Procedure | Threshold | runs in |
|---|---|---|---|---|---|
| T-REPLAY-1 | S-REPLAY-1 | Static | AST scan: no creation of a one-time artefact via a `jose` signature; every creation leads to an `INSERT` into a table with `token_sha256`/`challenge_sha256`/`state_sha256` as primary key. | **0 signed one-time artefacts**; 4 artefact types assigned | CI on every commit |
| T-REPLAY-2 | S-REPLAY-2 | Integration | For all 4 purposes (`email_verify`, `password_reset`, `email_change`, `magic_link`): create, redeem, redeem again. | **4/4** first redemption successful, second rejected; after the first redemption **0 rows** in `one_time_token` | CI on every commit |
| T-REPLAY-3 | S-REPLAY-3 | Integration | Three requests per purpose: expired token (advance the clock), consumed token, invented token. | **12/12 responses byte-for-byte identical** (4 purposes × 3 cases) | CI on every commit |
| T-REPLAY-4 | S-REPLAY-4 | Unit, controlled clock | Fix the clock, compute a code, submit it twice; advance the clock by 30 s, submit a new code; submit the code of the previous step; submit the code of the step before that. In addition check which `time_step` was recorded. | **5/5**: 200, 401, 200, 200, 401; the recorded `time_step` is that of the accepted code | CI on every commit |
| T-REPLAY-5 | S-REPLAY-5 | Integration, controlled clock | Create a challenge, use it, use it again; create a challenge and use it after 5 min + 1 s; submit a `register` challenge to `authenticate`. | **3/3**: second use rejected, expired one rejected, wrong-purpose one rejected — all with the same response | CI on every commit |
| T-REPLAY-6 | S-REPLAY-6 | Integration + Static | Call the callback twice with the same `state`; call the callback with an invented `state`; try to set a configuration without PKCE (type check); OIDC callback with a wrong `nonce` and with a wrong `iss`. | **5/5** rejected; **0 option keys** that switch PKCE off; `oauth_flow` **0 rows** after the first callback | CI on every commit |

---

### 6.5 RAND — Insecure randomness

| Test ID | verifies | Kind | Procedure | Threshold | runs in |
|---|---|---|---|---|---|
| T-RAND-1 | S-RAND-1 | Static | Lint rule over `src/`: `Math.random`, `Date.now` in a token context, UUID libraries. Exceptions only with a comment marker and a justification. | **0 hits without a marker**; every marker has a justification text | CI on every commit |
| T-RAND-2 | S-RAND-2 | Unit | Create 1000 session tokens; check length, alphabet and pairwise distinctness; measure the decoded byte length. | Length **43 characters** base64url, decoded **32 bytes**, **0 duplicates** among 1000 | CI on every commit |
| T-RAND-3 | S-RAND-3 | Unit | Create 100 sets of 10 recovery codes each; check the decoded bit length and distinctness. | **160 bit** per code; **0 duplicates** within a set; 0 duplicates across all 1000 | CI on every commit |
| T-RAND-4 | S-RAND-4 | Unit | 1000 values each for one-time tokens, `state`, PKCE verifier and WebAuthn challenge. | **≥ 256 bit** decoded in each case; PKCE verifier additionally 43–128 characters (RFC 7636) | CI on every commit |
| T-RAND-5 | S-RAND-5 | Static | AST scan: calls to `crypto.getRandomValues` outside the randomness module. | **0 hits outside** `core/token/random.ts` | CI on every commit |
| T-RAND-6 | S-RAND-6 | Static + Integration | Type check: a function that expects an `EntityId` does not accept a `Secret` and vice versa (`expectTypeOf`). An integration test searches all `Set-Cookie` and body values of the entire suite for `uuid` values from `velve.session.id`. | **0 type errors missing** (2 negative cases do not compile); **0 hits** across all integration responses | CI on every commit |
| T-RAND-Verteilung | S-RAND-2/3/4 (supplementary) | Statistical | N = 100,000 tokens per artefact type; character frequency per position; monobit and runs test at bit level (NIST SP 800-22). | Chi-square per position **p > 0.001**; monobit **p > 0.001**; runs **p > 0.001** | CI nightly |
| T-RAND-Kollision | S-RAND-2 (supplementary) | Concurrency | Create 1 million tokens in 8 parallel workers, write them into a set. | `set.size === 1_000_000` | CI nightly |

---

### 6.6 TOKEN — Token reuse and single use

| Test ID | verifies | Kind | Procedure | Threshold | runs in |
|---|---|---|---|---|---|
| T-TOKEN-1 | S-TOKEN-1 | Static | AST scan of all SQL literals against `one_time_token`: each contains `purpose` in the `WHERE`. In addition a type check that the repository method does not compile without a purpose argument. | **0 literals without `purpose`**; the negative case does not compile | CI on every commit |
| T-TOKEN-2 | S-TOKEN-2 | Integration, exhaustive | Cross matrix 4 purposes × 4 redemption paths = 16 combinations. | **4 diagonal cases successful, 12 rejected**; the 12 responses are byte-for-byte identical to the response to an invented token | CI on every commit |
| T-TOKEN-3 | S-TOKEN-3 | Integration | Request a reset twice in a row, then redeem the first token. | After the second request **exactly 1 row** with `(user_id, purpose)`; first token rejected | CI on every commit |
| T-TOKEN-4 | S-TOKEN-4 | Integration | (i) Create an email-change token for user A and redeem it with user B's session cookie. (ii) Start the linking from A's session, call the callback with A's pointer cookie and B's session cookie. In addition an AST scan: no handler reads a user identifier from the input of a redemption path. | **2/2: the effect hits A** (`user.email` resp. `identity.user_id`), **0 row changes on B**; **0 AST hits** | CI on every commit |
| T-TOKEN-5 | S-TOKEN-5 | Integration, reflective | Create a test user with one row in each of the 13 user-bound tables, run `DELETE FROM velve.user`, count all tables. The list of tables comes from `information_schema`, not from a constant. | `count(*)` = **0 in 13/13 tables** | CI on every commit |
| T-TOKEN-6 | S-TOKEN-6 | Integration, reflective | After running all migrations (core and test plugin), query `information_schema`: every table in the schema `velve` with a `user_id` column must carry an FK constraint with `ON DELETE CASCADE`. In addition apply a deliberately faulty plugin migration. | **0 tables without cascade**; the faulty migration is rejected by the runner with an error | CI on every commit |

---

### 6.7 RATE — Rate limiting

| Test ID | verifies | Kind | Procedure | Threshold | runs in |
|---|---|---|---|---|---|
| T-RATE-1 | S-RATE-1 | Unit, table-driven | Vector table input → expected key: `2001:db8::1`, `2001:0db8:0000:…:0001`, `2001:DB8::1`, `2001:db8:0:0:ffff::9999` → all `2001:db8::/64`; `::ffff:203.0.113.5` and `203.0.113.5` → equal; `::1`; `0.0.0.0`; `::`; empty string; `not-an-ip`; `1.2.3.4, 5.6.7.8`. | **20/20 vectors correct** | CI on every commit |
| T-RATE-2 | S-RATE-2 | Integration | 1000 requests from 1000 addresses out of one `/64`; counter-check 1000 requests from 1000 different `/64`. | Exactly **`limit` successes** in the first case; **1000 successes** in the second | CI on every commit |
| T-RATE-3 | S-RATE-3 | Integration | (i) `trustedProxies` empty, 100 requests with a random `X-Forwarded-For` from the same socket address. (ii) `trustedProxies = ["10.0.0.0/8"]`, socket `10.0.0.5`, `XFF: 1.2.3.4, 10.0.0.9` → key `1.2.3.4`. (iii) socket `203.0.113.1` (not trusted), `XFF: 9.9.9.9` → key `203.0.113.1`. | **6/6 constellations**; in (i) exactly `limit` successes | CI on every commit |
| T-RATE-4 | S-RATE-4 | Integration | Requests without a determinable peer address (Unix socket transport or a test switch set). | After `limit` requests the rejection comes; **0 skipped checks** in the counter log | CI on every commit |
| T-RATE-5 | S-RATE-5 | Integration | Send seven path variants of the same route mixed: `/sign-in/password`, `//sign-in/password`, `/sign-in/password/`, `/./sign-in/password`, `/sign-in//password`, `/sign-in/passw%6Frd`, `/SIGN-IN/PASSWORD`. | **All 7 share one bucket**: after `limit` requests in total the rejection comes, regardless of the mixture | CI on every commit |
| T-RATE-6 | S-RATE-6 | Concurrency | 200 requests via `Promise.all` against real Postgres at limit 20; 50 repetitions. | **Exactly 20 successes and 180 rejections in 50/50 runs, tolerance 0** | CI nightly |
| T-RATE-7 | S-RATE-7 | Integration + Static, controlled clock | `capacity` failed attempts plus one against an existing account and against a non-existent identifier; then advance the clock by the refill time and sign in with the correct password. Search `rate_bucket.bucket_key` for the identifier. Type check: the options type contains no key for a delay or a lockout. | The **(capacity + 1)-th** attempt returns `rate_limited` — for both identifiers after the same number; sign-in after the refill **successful**; median latency of the rejected responses **lower** than that of a regular failed sign-in (no KDF, no delay); **0 plaintext hits** in `bucket_key`; **0 option keys** | CI on every commit |
| T-RATE-8 | S-RATE-8 | Integration | Configure the global route counter with a low threshold value, exceed the threshold. | Alarm callback called **≥ 1 time**; **0 requests rejected** | CI on every commit |

---

### 6.8 COOKIE — Cookie attributes

| Test ID | verifies | Kind | Procedure | Threshold | runs in |
|---|---|---|---|---|---|
| T-COOKIE-1 | S-COOKIE-1 | Integration | Parse `Set-Cookie` after a successful sign-in and compare it against a fixture. | Name **exactly** `__Host-velve_session`; attribute set exactly `{HttpOnly, Secure, SameSite=Lax, Path=/}`; **0 deviations** | CI on every commit |
| T-COOKIE-2 | S-COOKIE-2 | Static | Type check: the options type contains no key for cookie attributes; AST scan: the attribute set is constructed in exactly one place and is not extended by a spread. | **0 option keys**; **exactly 1 construction site**, **0 spread extensions** | CI on every commit |
| T-COOKIE-3 | S-COOKIE-3 | Integration, controlled clock | Trigger a sign-in with a second factor, parse the cookie; advance the clock by 5 min + 1 s, call `POST /factor/verify`. | Name `__Host-velve_pending`, `Max-Age` **300**, same attribute set; after expiry **rejected** | CI on every commit |
| T-COOKIE-4 | S-COOKIE-4 | Integration | Decode the cookie value after every session-creating response and check it for length and structure. | The value is **exactly one** base64url token of 43 characters; **0 further fields**, no separators | CI on every commit |
| T-COOKIE-5 | S-COOKIE-5 | Integration | Send a request with `Cookie: __Host-velve_session=A; __Host-velve_session=B`, where B is valid. | **HTTP 400**; **no** session resolved; no access to A or B | CI on every commit |
| T-COOKIE-6 | S-COOKIE-6 | Integration, reflective | Collect every `Set-Cookie` name over the entire integration suite and reconcile it against the constant `ALL_COOKIES`. | Collected set **equal to** `ALL_COOKIES`; **0 unknown names**, **0 entries never set** | CI on every commit |

---

### 6.9 CSRF — Cross-Site Request Forgery

| Test ID | verifies | Kind | Procedure | Threshold | runs in |
|---|---|---|---|---|---|
| T-CSRF-1 | S-CSRF-1 | Integration, generated + Static | Call every route from the route table with a foreign `Origin` — once through the HTTP handler, once through the direct server method. Static: exactly one route carries `originCheck: "exempt"`. | **All routes except the OAuth callback rejected** with `origin_not_allowed` on both paths; 0 row changes; **exactly 1** route with `exempt`, and that is `signIn.oauth.callback` | CI on every commit |
| T-CSRF-2 | S-CSRF-2 | Static + Unit | AST scan: in `core/http/origin.ts` no `startsWith`, `includes`, `endsWith`, `RegExp`. Unit: allowed origin, same origin with a different port, with a different scheme. | **0 hits**; **3/3 unit cases** correct | CI on every commit |
| T-CSRF-3 | S-CSRF-3 | Integration, exhaustive | All state-changing routes × 8 origin variants: allowed, missing, `null`, `http://` instead of `https://`, `sub.erlaubt.de`, `erlaubt.de.evil.com`, `erlaubt.de:8443`, `evil.de`. | Only the *allowed* variant is successful; **all rejections byte-for-byte identical** | CI on every commit |
| T-CSRF-4 | S-CSRF-4 | Static + Integration | Filter the route table: every `GET` route is the OAuth callback or one of the seven reading routes from S-CSRF-4. Integration: call every reading `GET` route and compare the row counts of all tables before and afterwards (`last_used_at`/`idle_expires_at` of the caller's own session excepted). | **0 unclassified GET routes**; **0 row changes** by reading routes | CI on every commit |
| T-CSRF-5 | S-CSRF-5 | Integration | Start a complete OAuth flow in context A, call the callback URL in context B (different pointer cookie); additionally without any cookie. | **2/2 rejected**; **0** new rows in `session` and `identity` | CI on every commit |
| T-CSRF-6 | S-CSRF-6 | Integration + Static | Test plugin that tries to register a middleware before the origin check and to replace the check function. | Registration leads to a **start error**; the context is frozen (`Object.isFrozen` = true) | CI on every commit |
| T-CSRF-Parser | S-CSRF-2/3 (supplementary) | Property | fast-check generates host names with prefix, suffix, port, Unicode and punycode variants of the allowed hosts. | **2000 cases, 0 counterexamples**, fixed seed | CI nightly |

---

### 6.10 OWNER — Missing owner binding / IDOR

| Test ID | verifies | Kind | Procedure | Threshold | runs in |
|---|---|---|---|---|---|
| T-OWNER-1 | S-OWNER-1 | Static | `ts-morph`: read the tables with a `user_id` column from `information_schema`, determine every repository method that accesses one of them, and check whether its signature carries an `actor`. | **0 methods without `actor`**; the test also fails if a new table with `user_id` appears without a corresponding repository | CI on every commit |
| T-OWNER-2 | S-OWNER-2 | Static | AST scan of all SQL literals that run a `DELETE` or `UPDATE` on a user-bound table: each must contain `user_id` in the `WHERE`. In addition: no `SELECT` on the same table immediately before it in the same function. | **0 literals without a `user_id` predicate**; **0 preceding `SELECT`** | CI on every commit |
| T-OWNER-3 | S-OWNER-3 | Integration | Users A and B each create two WebAuthn credential records (so that `last_sign_in_method` does not bite). B calls `POST /factor/webauthn/remove` with A's `credentialId`; then with a freely invented UUID. | **2/2 rejected**, responses **byte-for-byte identical**; `SELECT count(*)` on A's record before/after **unchanged** | CI on every commit |
| T-OWNER-4 | S-OWNER-4 | Integration | B calls `POST /session/revoke` with A's `targetSessionId`; then with an invented identifier. | **2/2 responses 204 and byte-for-byte identical**; A's session stays valid; **0 row changes** in `velve.session` | CI on every commit |
| T-OWNER-5 | S-OWNER-5 | Integration | B unlinks A's identity link. | Rejected; `velve.identity` **0 row changes**; response identical to the response to an invented identifier | CI on every commit |
| T-OWNER-6 | S-OWNER-6 | Integration, generated | For every route with a parameter that could sit in more than one source: request with contradictory values in query and body. | **HTTP 400 on all affected routes**; neither of the two values is ever chosen | CI on every commit |
| T-OWNER-7 | S-OWNER-7 | Static | AST scan: no assignment from `req.body`, `req.query` or a header entry to a variable of type `UserId` or `Actor`. | **0 hits** | CI on every commit |
| T-OWNER-8 | S-OWNER-8 | Integration, generated | For every route with an object identifier: call it once with a foreign and once with an invented identifier and compare the responses byte for byte. | **0 differing bytes** across all route pairs | CI on every commit |
| T-OWNER-9 | S-OWNER-9 | Static | Check the migration artefact against `information_schema`: no column of type `serial`, `bigserial`, `integer` or `bigint` is the primary key of a user-bound table. | **0 sequential primary keys** | CI on every commit |
| T-OWNER-10 | S-OWNER-10 | Integration | Test plugin tries (i) a direct `INSERT` into `velve.session` through the driver from the context, (ii) `ctx.repositories = …`. | (i) The context offers no raw driver — does not compile; (ii) throws `TypeError` (frozen object): **2/2** | CI on every commit |
| T-OWNER-11 | S-OWNER-11 | Integration | Test plugin registers a route with the path of a core route; a second test plugin collides with the first. | **2/2 lead to a start error**; the error message names both contributors | CI on every commit |
| T-OWNER-12 | S-OWNER-12 | Integration | Test plugin hook returns a response body and tries to replace the verifier. | The hook's return value **does not influence the response**; the replacement does not compile; a throwing hook rejects the operation: **3/3** | CI on every commit |

---

### 6.11 LINK — Account takeover via identity linking

| Test ID | verifies | Kind | Procedure | Threshold | runs in |
|---|---|---|---|---|---|
| T-LINK-1 | S-LINK-1 | Static + Integration | AST scan: no query on `velve.identity` or `velve.user` that uses a provider email as a linking predicate. Integration: two providers report the same email with different `subject`. | **0 hits**; the integration produces **2 separate identity rows**, not one link | CI on every commit |
| T-LINK-2 | S-LINK-2 | Integration, state matrix | 3 local states (absent, present unverified, present verified) × 2 provider states (`email_verified` true/false) × 2 (`trustedProviders` contains the provider / does not) = **12 cases**, expectation table as a fixture. | **12/12 as expected**; in particular (locally unverified, provider verified, trusted) does **not** lead to a silent link | CI on every commit |
| T-LINK-3 | S-LINK-3 | Integration + Static | Provider double returns an email address as `sub`. AST scan: the assignment to `subject` comes from the `sub` claim, never from `email`. | Stored `subject` is the `sub` value; **0 AST hits** | CI on every commit |
| T-LINK-4 | S-LINK-4 | Integration | Reproduce the attacker path: register an account with a password (unverified), redeem a magic link to the same address, then sign in with the original password. Counter-check: register an account with a password and redeem the confirmation link in the same session. Third case: magic link while a provider identity with the same email exists. | Attacker path: `email_verified_at` set, `password_credential` **0 rows**, all sessions created before the confirmation revoked (**0 rows**), sign-in with the original password fails with `invalid_credentials`. Counter-check: `password_credential` **1 row**, session stays valid. Third case: `velve.identity` **0 new rows** | CI on every commit |
| T-LINK-5 | S-LINK-5 | Integration + Static | Provider double returns no email. AST scan: no string concatenation that produces an email address from an identifier (`@` literal in an assignment to `email`). | `user.email IS NULL`; **0 AST hits** | CI on every commit |
| T-LINK-6 | S-LINK-6 | Integration | User with two identities; provider 1 reports `email_verified: true`, provider 2 `false`. | `provider_email_verified` is **correct per row**; a change to row 1 leaves row 2 unchanged | CI on every commit |
| T-LINK-7 | S-LINK-7 | Integration | Link a second identity in an existing session, compare the token before and afterwards. | `T2 ≠ T1`; the old row **0 hits** in `velve.session` | CI on every commit |

---

### 6.12 CACHE — Authorisation decision from a cache

| Test ID | verifies | Kind | Procedure | Threshold | runs in |
|---|---|---|---|---|---|
| T-CACHE-1 | S-CACHE-1 | Integration + Static | Counting driver: for *n* consecutive requests with the same cookie, count the number of resolution queries. AST scan for `Map`, `LRU`, `WeakMap` in `core/session/`. A response interceptor over the entire integration suite checks `Cache-Control` and `Vary`. | **n queries for n requests** (ratio exactly 1.0); **0 cache structures** in the module; **100 %** of the responses carry `Cache-Control: no-store` and `Vary: Cookie` | CI on every commit |
| T-CACHE-2 | S-CACHE-2 | Integration + Static | Four negative cases: unknown token, `idle_expires_at` in the past, `absolute_expires_at` in the past, `disabled_at` set. In addition compare the SQL literal against a fixture. | **4/4 rejected** (three times `null`, `account_disabled` for `disabled_at`); the resolution SQL is **byte-for-byte equal** to the fixture (every change is a deliberate decision) | CI on every commit |
| T-CACHE-3 | S-CACHE-3 | Integration | Create a session, call a protected route (success), set `disabled_at`, call again immediately. | Rejection on the **first** subsequent request, measured latency between lockout and effect **< 100 ms** | CI on every commit |
| T-CACHE-4 | S-CACHE-4 | Integration, exhaustive | In the intermediate state (only `__Host-velve_pending`) call **every** registered route. | **Exactly 4 routes** behave differently than for a request without any cookie, and they are exactly those with `caller: "pending"`; all the others return the **byte-for-byte identical** response | CI on every commit |
| T-CACHE-5 | S-CACHE-5 | Integration | Test plugin tries to override `resolveSession` and to register a resolution hook of its own. | Does not compile resp. **start error**; the number of resolution queries stays at ratio 1.0 | CI on every commit |

---

### 6.13 REDIR — Open redirect and URL validation

| Test ID | verifies | Kind | Procedure | Threshold | runs in |
|---|---|---|---|---|---|
| T-REDIR-1 | S-REDIR-1 | Static | Type check of the route declaration: every field that carries a redirect target has the type `RedirectPath`, never `string` or `URL`. | **0 fields of type `string`** in this role | CI on every commit |
| T-REDIR-2 | S-REDIR-2 | Unit, corpus | Vector file with at least 120 malicious inputs: protocol-relative, backslash, userinfo, suffix, substring, port, IDN/punycode, double-encoded, `\r\n` injection, null byte, `javascript:` in 8 spellings. | **120/120 rejected, 0 false negatives**; the corpus grows by the vector with every finding | CI on every commit |
| T-REDIR-3 | S-REDIR-3 | Integration, global | Response interceptor over the entire integration suite: capture every `Location` value and check that it begins with exactly one `/` and contains neither `:` before the first `/` segment nor `//` nor `/\`; in addition count which routes set `Location` at all. | **0 `Location` values** with a scheme or a host; `Location` occurs **only** in the response of the OAuth callback | CI on every commit |
| T-REDIR-4 | S-REDIR-4 | Integration, global | The same interceptor searches `Location` and all query strings for the token plaintexts created in this test run. | **0 hits** over the entire suite | CI on every commit |
| T-REDIR-5 | S-REDIR-5 | Static | AST scan over `core/http/`: no `startsWith`, `includes`, `endsWith`, `RegExp` and no wildcard character in an origin comparison. | **0 hits** | CI on every commit |
| T-REDIR-6 | S-REDIR-6 | Static + Integration | AST scan: every outgoing request URL comes from the configuration object. Integration: provider double returns divergent endpoints in the discovery document. | **0 URLs from request data**; the divergent endpoints are **not** called | CI on every commit |
| T-REDIR-7 | S-REDIR-7 | Integration, global | Check the `Content-Type` of every response over the entire suite; in addition search every response body for a canary value that was previously written into every input field. | **100 % `application/json`**; **0 canary hits** in response bodies | CI on every commit |

---

### 6.14 REST — Secrets at rest

| Test ID | verifies | Kind | Procedure | Threshold | runs in |
|---|---|---|---|---|---|
| T-REST-1 | S-REST-1 | Integration | Create a test user with all artefact types (password and its PHC string, session token, intermediate-state token, 4 one-time tokens, TOTP secret, 10 recovery codes, WebAuthn challenge, `state`, PKCE verifier, foreign access and refresh token). Produce `pg_dump --schema=velve` as text and search for every plaintext value as well as its Base64 and hex encoding. | **0 hits over 24 values × 3 encodings = 72 searches** | CI on every commit |
| T-REST-2 | S-REST-2 | Integration + Static | For the 5 hash columns: read the value from the database and compare it against `sha256(plaintext)`; check the column type from `information_schema`. | **5/5 columns are `bytea` with exactly 32 bytes** and match the computed hash | CI on every commit |
| T-REST-3 | S-REST-3 | Integration | Create 10 codes; check the row count; compare the stored value against `HMAC-SHA256(pepper, code)` with the `token-pepper` key of the version named in `key_version`; redeem code 3, redeem it again, redeem code 4. | **10 rows**, value matches, `key_version` = current version in **10/10**; **3/3**: success, rejection, success; after redeeming code 3 there are **9 rows** left | CI on every commit |
| T-REST-4 | S-REST-4 | Integration | For the 5 encrypted columns: read the raw bytes, parse the envelope, decrypt with the purpose key, compare against the input value; in addition decrypt with a wrong purpose key. | **5/5 decryptable** with the correct key; **5/5 fail** with the wrong one; the ciphertext does not contain the plaintext as a subsequence | CI on every commit |
| T-REST-5 | S-REST-5 | Unit + Integration | Import a hash for each of the eleven prefixes of the switch from section 3.3; read the raw bytes of `password_credential.phc`, decrypt them with the key `password-enc` of the version named in `key_version` and check the prefix; search the raw bytes for `$`. In addition an AST scan for a write to `phc` without the encryption call. | **11/11 decrypted values begin with the expected prefix**; **0 `$` bytes** at position 0 of the raw bytes; `scheme` is plaintext and matches; **0 AST hits** | CI on every commit |
| T-REST-6 | S-REST-6 | Integration + Static | Complete an OAuth flow without the option set; check the columns. Type check: `storeTokens` is optional and the default is `false`. | `access_token_enc`, `refresh_token_enc`, `id_token_enc` **all NULL**; default value in the type **`false`** | CI on every commit |
| T-REST-7 | S-REST-7 | Unit | Create a hash, parse the PHC string; then check a hash with weaker parameters and a bcrypt hash and evaluate `needsRehash`. | Created parameters **exactly** `m=19456,t=2,p=1`, salt 16 bytes, output 32 bytes; `needsRehash` = **true in both legacy cases**, **false** for the current one | CI on every commit |

---

### 6.15 KEY — Key management and rotation

| Test ID | verifies | Kind | Procedure | Threshold | runs in |
|---|---|---|---|---|---|
| T-KEY-1 | S-KEY-1 | Unit | Derive all six purpose keys from a fixed root key and compare them pairwise; check the derivation against test vectors from RFC 5869. | **6 pairwise different keys**; HKDF matches **all 7 test vectors from RFC 5869 Appendix A** | CI on every commit |
| T-KEY-2 | S-KEY-2 | Unit, exhaustive | All ordered pairs of the 6 purposes (30 combinations): create with purpose *i*, verify resp. decrypt with purpose *j ≠ i*. | **30/30 fail** | CI on every commit |
| T-KEY-3 | S-KEY-3 | Integration | Create every protected value (TOTP secret, PKCE verifier, foreign OAuth tokens, PHC string, recovery code) and read the version information (envelope or column). | **5/5 values carry the current version**; **0 values without a version** | CI on every commit |
| T-KEY-4 | S-KEY-4 | Unit | Call `byVersion` for a version present in the ring and for a removed one; then decrypt a value encrypted with the removed version. | The present version returns a key; the removed one returns **`null`**; the decryption throws a named error (`KeyVersionUnavailable`), **not a generic crash** | CI on every commit |
| T-KEY-5 | S-KEY-5 | Integration | Create a session, write an encrypted field. Switch the ring to `v2,v1` and restart the process; then reduce the ring to `v2` and restart again. | Session valid after **both** steps; field decryptable after step 1; new values carry `v2`: **4/4 assertions** | before every release |
| T-KEY-6 | S-KEY-6 | Unit | Start attempts with root keys of the lengths 0, 8, 31 and 32 bytes as well as with a missing `keys` field. | **4 out of 5 refuse to start**, only 32 bytes starts: **5/5** | CI on every commit |
| T-KEY-7 | S-KEY-7 | Unit | Check an ID token with `alg: "none"`, with `HS256` under the root key, with a foreign RSA key and with the correct JWKS key. | **3/3 rejected**, 1 accepted; the allowlist is a constant and is read in the test | CI on every commit |

---

### 6.16 RACE — Concurrency when consuming one-time artefacts

| Test ID | verifies | Kind | Procedure | Threshold | runs in |
|---|---|---|---|---|---|
| T-RACE-1 | S-RACE-1 | Concurrency | For each of the 4 one-time token purposes: `Promise.all` with 50 identical requests against real Postgres; 20 repetitions. | **Exactly 1 success and 49 failures in 20/20 runs per purpose, tolerance 0** | CI nightly |
| T-RACE-2 | S-RACE-2 | Static + Concurrency | AST rule: no `find*`/`SELECT` on a table followed by `delete*`/`update*` on the same table in the same function. In addition the same concurrency test as T-RACE-1, but with a 50 ms artificial delay between reading and writing via a driver hook. | **0 AST hits**; with the delay still **1/49 in 20/20 runs** | CI on every commit (static) / CI nightly (concurrency) |
| T-RACE-3 | S-RACE-3 | Concurrency | 50 parallel submissions of the same TOTP code with a fixed clock; 20 repetitions. | **Exactly 1 success in 20/20 runs**; `totp_used_step` contains **exactly 1 row** | CI nightly |
| T-RACE-4 | S-RACE-4 | Concurrency | 50 parallel submissions of the same recovery code; 20 repetitions. | **Exactly 1 success in 20/20 runs**; afterwards **9 rows** in `recovery_code` | CI nightly |
| T-RACE-5 | S-RACE-5 | Integration, fault injection | A driver hook throws after the `INSERT` of the new session and before the `DELETE` of the old one; separately after the password `UPDATE` and before the revocation. | After the rollback: `velve.session` **unchanged**; password **unchanged**: **2/2** | CI on every commit |
| T-RACE-6 | S-RACE-6 | Integration, concurrency | Two simultaneous sign-ins of the same user with a hash in need of a rehash; then a sign-in in which a third party changes the hash between reading and writing. | **Exactly 1** of the two rehashes takes effect, the other changes 0 rows; **0 errors** in the response; the hash is valid after both runs | CI nightly |

---

### 6.17 DEFAULT — Insecure default values

| Test ID | verifies | Kind | Procedure | Threshold | runs in |
|---|---|---|---|---|---|
| T-DEFAULT-1 | S-DEFAULT-1 | Static + Integration | Keep all security-relevant keys from the options type in a constant `SECURITY_OPTIONS`; for each of them the default value is deposited as a fixture. On start with a divergent assignment the log sink is checked. | Default values **exactly equal** to the fixture; every deviation produces **exactly 1** log entry with the option name; the test fails if the options type contains a key that is not in `SECURITY_OPTIONS` | CI on every commit |
| T-DEFAULT-2 | S-DEFAULT-2 | Static | Type check: no option key contains the character sequence `revoke` as a switch that can be turned off; for the integration counter-check see T-FIX-6. | **0 option keys** | CI on every commit |
| T-DEFAULT-3 | S-DEFAULT-3 | Static | Type check against a list of forbidden option names (`disablePkce`, `disableOriginCheck`, `disableRateLimit`, `skipStateCheck` and variants). | **0 hits**; the test reads the list from a constant | CI on every commit |
| T-DEFAULT-4 | S-DEFAULT-4 | Unit | Call `createVelveAuth({ identity: "username" })` without `recoveryCodes: true`; then with it. | **The first call throws**, the second starts: **2/2**; the message names both options | CI on every commit |
| T-DEFAULT-5 | S-DEFAULT-5 | Integration | Three kinds of conflict once each: plugin route against core route, table prefix of two plugins, error code of two plugins. | **3/3 start errors**; **0 warnings without an error** | CI on every commit |
| T-DEFAULT-6 | S-DEFAULT-6 | Unit | Configurations with `m = 19456/t = 2/p = 1`, with higher values and with one lower value per parameter each. | The default and higher values start; **3/3 lower values** lead to a start error | CI on every commit |
| T-DEFAULT-7 | S-DEFAULT-7 | Integration | Hash the same set of 20 passwords once with the `hash-wasm` dependency present and once with it missing, and check them crosswise. | **20/20 created PHC strings byte-for-byte equal**; every cross-check successful: **40/40** | before every release |

---

### 6.18 DOS — Resource exhaustion through the KDF

| Test ID | verifies | Kind | Procedure | Threshold | runs in |
|---|---|---|---|---|---|
| T-DOS-1 | S-DOS-1 | Unit | A KDF spy counts calls. Inputs: empty password, 7 characters, 8 characters, 4096 bytes, 4097 bytes, 1 MiB. | **0 KDF calls** for empty, 7 characters, 4097 bytes and 1 MiB; **1 call** for 8 characters and for 4096 bytes | CI on every commit |
| T-DOS-2 | S-DOS-2 | Integration | Sign in with a 1 MiB password against an existing and against a non-existent identifier; an instrumented driver counts queries; 200 measurements per group. | Responses **byte-for-byte identical**; **0 database queries and 0 KDF calls** in both cases; difference of the median times **< 5 ms** | CI nightly |
| T-DOS-3 | S-DOS-3 | Concurrency | 200 simultaneous sign-ins; observe running KDF calls through a counter in the semaphore; measure memory via `process.memoryUsage().rss`. | Observed maximum of simultaneous KDF calls **≤ min(4, cpus)**; RSS growth **< min(4, cpus) × 19 MiB × 1.5** | CI nightly |
| T-DOS-4 | S-DOS-4 | Concurrency | 500 simultaneous sign-ins at semaphore size 1 and with an artificially slowed KDF. | **500/500 responses** with a valid status code; **0 crashes**, **0 unhandled rejections**; every response arrives within the wait limit of 5 s plus 500 ms tolerance, and every response after the wait limit carries `rate_limited` | CI nightly |
| T-DOS-5 | S-DOS-5 | Integration | Set the rate limit to 5, send 100 requests from one IP, count with the KDF spy. | **At most 5 KDF calls** for 100 requests | CI on every commit |
| T-DOS-6 | S-DOS-6 | Concurrency | 50 sign-ins with hashes in need of a rehash; observe the semaphore counter. | Maximum of simultaneous KDF calls (verification **and** rehash together) **≤ min(4, cpus)** | CI nightly |

---

### 6.19 Test infrastructure

**Real PostgreSQL instance, no mock.** An in-memory adapter tests the wrong semantics. Four groups of requirements of this report are statements about the behaviour of the database and not about the application code: the atomicity of `DELETE … RETURNING` (S-RACE-1, S-RACE-2), the serialisation over primary-key conflicts (S-RACE-3, S-RACE-4), the effect of the `UPDATE` trigger on `session.user_id` (S-FIX-2) and cascading deletion (S-TOKEN-5, S-TOKEN-6). A mock that reproduces `DELETE … RETURNING` in JavaScript is exactly the code whose absence the test is supposed to prove. On top of that, all the SQL is hand-written (section 3.2) — a syntax error or a wrong index usage only shows up against a real server. Concretely: **Testcontainers with PostgreSQL 14** as the lowest supported version, plus a nightly run against the current major version. Every test case runs in a schema namespace of its own or in a transaction with a rollback; concurrency tests need a real database without rollback isolation and clean up after themselves.

**Controllable clock.** All expiry, window and TOTP tests need a deterministic time. The core reads the time exclusively through the configuration option `clock: Clock` (section 3.15 A.2, `interface Clock { now(): Date }`) and through `now()` in the database. `@velve/auth/testing` (section 3.1) exports a settable `Clock` that the test passes into the configuration; `vi.useFakeTimers` is only needed for the wait limit of the semaphore (S-DOS-4), because that one runs on a timer and not on `clock`. For the database side the expiry timestamps are written directly in the test instead of shifting the server time; a test that needs both sets `clock` and writes `expires_at` to match.

**Deterministic randomness, and how to make it impossible in production.** Reproducible counterexamples need a settable seed; a settable seed in production would be the gravest conceivable weakness. Three barriers together:

1. The switch lies exclusively in `@velve/auth/testing` — a subpath export of its own (section 3.1). The core does not import this module; the reverse is checked by an AST rule (**threshold: 0 imports of `testing` in `core/`**).
2. The core does not take the random generator as a parameter. The switch happens through a setter function that checks on the first call whether `process.env.NODE_ENV === "test"` **and** whether the test module is the caller; otherwise it throws.
3. A delivery test checks the packed artefact: the package contains the setter only in the `testing` subpath, and the core entry point does not contain the character sequence of the setter name (**threshold: 0 hits in `dist/index.js`, runs before every release**).

With that, switching it on in production is prevented not by discipline but by the package structure, and the failure case is a throw instead of a silent change of behaviour.

**Mail-sending double.** The library does not deliver mail sending but a callback (section 3.15 A.7, `email: { send }`; section 3.14). The double implements this callback, collects messages in an array and provides three queries: number of calls, recipient, `kind` of the message. It is the measurement point for S-ENUM-4 (symmetry of the side effect), for S-TIM-6 (exactly one callback call per request, independent of the existence of the account, L-1) and for all flows whose visible difference, according to section 3.13, moves "solely into the email that is sent". It must also be able to throw, because A.7 stipulates that a throwing `send` makes the operation fail and rolls the one-time token back.

**WebAuthn simulator.** `@simplewebauthn/server` (section 2.7) verifies attestations and assertions; for the test the other side is needed. The simulator holds a P-256 key pair per virtual authenticator, produces `clientDataJSON` and `authenticatorData` with settable flags (UP, UV, BE, BS) and a settable `signCount`, and signs correctly. That makes four things testable that otherwise only work manually: the distinction between device-bound and synchronised via BE/BS (section 3.6), the `sign_count` handling, the single use of the challenge (T-REPLAY-5) and the discoverable sign-in without a prior user identifier. The simulator must also be able to sign *incorrectly* — otherwise the rejection is never tested.

**Summary of the tools.** Vitest as the runner; `@fast-check/vitest` for the property tests; Testcontainers for PostgreSQL; `ts-morph` for the project's own static rules (actor obligation, find-then-delete, secret comparisons, SQL literal analysis); `simple-statistics` for Welch t and chi-square, Cliff's delta as a function of its own of around 20 lines; `osv-scanner` and Renovate for the supply chain — GHSA-x732-6j76-qmhm (`rou3`) and GHSA-hq75-xg7r-rx6c (`better-call`) were both transitive faults.

---

### 6.20 Handling flakiness in timing measurements

This is the practical main problem of this test plan. A timing test measures a difference of a few microseconds on a machine that serves other containers in parallel, regulates its clock frequency by temperature and whose scheduler can displace the process at any time. A naively built test is therefore either red without a fault or green despite a fault.

**The `dudect` approach.** Reparaz, Balasch and Verbauwhede describe in IACR ePrint 2016/1123 a procedure that gets by without a hardware model: two input classes (one fixed, one random), measured interleaved, evaluated with Welch's t-test — and the decision is made on a **t value**, not on a p value. The usual rejection threshold is **|t| > 4.5**. The reason is the decisive point for this plan: at n = 1000 per group a p-value test is so discriminating that every CI disturbance — a neighbouring container, a turbo-boost drop — produces a p value below 0.05. The t threshold, by contrast, is comparably interpretable across sample sizes. Trail of Bits' Testing Handbook (`appsec.guide/docs/crypto/constant_time_tool/dudect/`) adds three practical points: remove outliers over several percentile cuts in parallel instead of over one; pin the process to one core with `taskset` and avoid cores 0 and 1 while doing so, because kernel and interrupt load sit there; and set runs longer than five minutes, because more measurements increase the probability of detection.

**The measurement methodology for Velve Auth, concretely.**

| Parameter | Value | Rationale |
|---|---|---|
| Repetitions | 1000 per group, interleaved in random order | Not all X first and then all Y — otherwise one measures cache warm-up instead of the code path |
| Warm-up | first 100 measurements per group discarded | JIT compilation, connection setup, page faults on the first Argon2id call |
| Measured quantity | `process.hrtime.bigint()` around the handler; in addition TTFB over a real socket | The wall clock contains scheduler noise that the test does not want to measure; on Linux additionally CPU cycles via `perf_event_open`, where available |
| Outlier handling | 10 % trimmed mean; in addition median absolute deviation with factor 3 as a second cut | Two independent cuts, so that the decision does not hang on the chosen cut |
| Primary criterion | **\|Welch t\| < 4.5** | dudect convention |
| Secondary criterion | **Cliff's δ < 0.147** | distribution-free, insensitive to non-normality; "negligible effect" according to Romano |
| Calibration | A pair of demonstrably identical operations is measured along in the same run | The quotient `t_test / t_kalibrierung` factors out machine drift |
| Environment | dedicated runner, no shared CI container, process pinned to a core ≥ 2 with `taskset` | A shared runner is the most frequent cause of false alarms |

**What happens when a timing test goes red in CI.** Do not disable it. The order is fixed:

1. **A single red run is a suspicion, not a finding.** An alarm is only raised when **three consecutive nightly runs** breach the threshold. That pushes the false-alarm rate down by about three orders of magnitude and does not lower the ability to detect a real, constant leak, because a real leak occurs every night.
2. **The first step after the alarm is the deterministic test, not the statistical one.** T-TIM-1b (call sequence) and T-TIM-3 (comparison operators) are flake-free and name the cause. If one of them goes red, the statistical test is only the confirmation.
3. **If the deterministic test stays green, the calibration is checked.** If the calibration t value rises as well, the runner is the cause and not the code — then the runner is swapped, not the threshold.
4. **The threshold is never loosened in order to get the test green.** If the test cannot be made stable on the available infrastructure, it is taken out of the blocking path and continues to report as a ticket — with an entry in the test plan saying that the class is currently secured only structurally and not empirically. A defused test is worse than a disabled one, because it feigns security.
5. **Two-stage gating as a permanent state.** T-TIM-1b, T-TIM-3, T-TIM-7 and all `Static` tests block every commit. T-TIM-1, T-TIM-5, T-TIM-6 and T-DOS-2 run nightly and produce tickets. That is not a stopgap but the construction: the deterministic tests find the cause, the statistical one finds what the deterministic ones did not foresee.

---

### 6.21 What is not tested, and why

This delimitation is part of the test plan, not a gap in it. The core of the reasoning: Velve Auth does not write cryptography itself; the primitives come from the packages named in section 2.7 and from `crypto.subtle`, code of its own is only the PHC parser. Testing the correctness of a library one does not write examines the wrong thing — what has to be examined is the **use**: the parameters, the encoding, the error handling and the edge cases at the interface.

| Not tested | Secured instead by |
|---|---|
| The correctness of `@noble/hashes` (Argon2id, scrypt) | Known test vectors, see 6.22. In addition the bit-equality comparison against `hash-wasm` (T-DEFAULT-7) — two independent implementations that agree are a stronger argument than one's own test against one of the two |
| The correctness of `crypto.subtle` (SHA-2, HMAC, AES-256-GCM, PBKDF2) | Platform guarantee of Node ≥ 20 (section 2.5); the vectors from 6.22 run along anyway, because they cost nothing |
| The correctness of `@simplewebauthn/server` (COSE decoding, attestation formats, signature verification) | The WebAuthn simulator from 6.19 checks the **use**: origin and RP ID binding, single use of the challenge, `userVerification` policy, BE/BS evaluation, `signCount` handling. Attestation formats are not tested through — Velve Auth does not evaluate any attestation |
| The correctness of `otpauth` (HOTP/TOTP computation) | RFC 6238 test vectors (6.22) plus the project's own tests for replay protection, tolerance window and time-step binding — that is the part `otpauth` does not provide |
| The correctness of `jose` (JWS verification, JWKS retrieval) | The algorithm allowlist (T-KEY-7) and the `iss`/`nonce` check (T-REPLAY-6). The signature mathematics itself is not re-checked |
| The correctness of `bcryptjs` | The reference vectors from 6.22; in addition the documented 72-byte truncation as a test of its own, because that is a property the import relies on (section 3.3, "Known limitation") |
| The browser itself: whether `__Host-` really forbids `Domain` and whether `SameSite=Lax` takes effect | That is behaviour of the browser engine. What is checked is only that Velve Auth sets the attributes correctly (T-COOKIE-1, T-FIX-5) and that the residual uncertainty is caught (T-COOKIE-5). A one-off manual run against Chrome, Firefox and Safari during the design documents the assumption |
| PostgreSQL's transaction and constraint semantics | Assumed as given. The concurrency tests check that Velve Auth **uses** them, not that they work |
| The user interface of email sending, deliverability, template texts | Velve Auth delivers no sending, only a callback (section 3.14) |
| Load tests, throughput measurements, scaling behaviour | Not a security goal of this report. Exception: T-DOS-3 and T-DOS-4 measure memory and response behaviour under load, because they check a security requirement |

---

### 6.22 Test vectors

For every supported hash procedure, known vectors must run through before any behavioural test is meaningful. All vector tests are unit tests, run on every commit and have the threshold **"all vectors match byte for byte; 0 deviations"**.

| Procedure | Source of the vectors | Scope | Note |
|---|---|---|---|
| Argon2id | **RFC 9106**, section 5.3 (and 5.1/5.2 for Argon2d/Argon2i) | The reference vector with `p=4, τ=32, m=32, t=3`, password/salt/secret/AD from the RFC | The RFC vectors deliberately use different parameters than the production configuration — and that is right: the vector checks the implementation, the parameter test (T-REST-7) checks the configuration |
| scrypt | **RFC 7914**, section 11 | All 4 vectors, including `N=1048576, r=8, p=1` | The large vector needs 1 GiB and runs only nightly; the three small ones on every commit |
| PBKDF2-HMAC-SHA1 | **RFC 6070** | All 6 vectors | Checks the counter handling and the 16,777,216-iteration case (nightly) |
| PBKDF2-HMAC-SHA256 / -SHA512 | RFC 7914 section 11 uses PBKDF2-HMAC-SHA256 internally; in addition the widespread vectors from RFC 6070 with the PRF exchanged | 4 vectors each | RFC 6070 defines only SHA-1; the SHA-256/512 variants are cross-checked against `crypto.subtle` and `@noble/hashes` — two independent implementations |
| bcrypt | The reference vectors from Provos' and Mazières' `crypt_blowfish` test suite, as they are carried in the common implementations as `wordlist`/`test vectors`; in addition the four prefix variants `$2a$`, `$2b$`, `$2y$`, `$2x$` | ≥ 20 vectors | Must expressly contain a vector with a password > 72 bytes and document the truncation (section 3.3) as well as one with a null byte, because `$2a$` and `$2x$` differ there |
| HKDF-SHA256 | **RFC 5869**, Appendix A | All 7 vectors | Basis for T-KEY-1 |
| TOTP | **RFC 6238**, Appendix B | All 18 vectors (SHA-1, SHA-256, SHA-512 × 6 points in time) | Velve Auth produces only SHA-1 (section 3.6); the remaining vectors run along, because `otpauth` can do them and a fault there would be a library fault |
| HMAC-SHA256 | **RFC 4231** | All 7 vectors | Basis for the recovery codes |

**Firebase scrypt: obtaining the vector yourself.** For `$fbscrypt$` there is no normative vector, because the procedure is a Google-proprietary composition: scrypt with a salt separator, followed by AES-256-CTR under a `signer_key`. A dependable vector comes only from a real export. The way:

1. Create a throwaway Firebase project and register a user with a known password by email/password in the authentication — the password is the only piece of information the export does not contain, so it has to be fixed beforehand.
2. Retrieve the hash parameters of the project. In the Firebase console they are under *Authentication → Users → overflow menu → Password hash parameters*; on the command line `firebase auth:export` delivers them in the header of the output. There are four values: `hash_config.signer_key` (Base64), `salt_separator` (Base64), `rounds` and `mem_cost`.
   **`signer_key` is a project-wide secret** — the vector therefore belongs in a throwaway project that is deleted afterwards, and never in a project with real users.
3. Run `firebase auth:export users.json --format=json --project <id>`. The entry contains `passwordHash` and `salt`, both Base64.
4. From the six values (password in plaintext, `salt`, `salt_separator`, `signer_key`, `rounds`, `mem_cost`) and the expected `passwordHash`, form a test vector and translate it into the PHC format from section 3.3: `$fbscrypt$v=1,n=<mem_cost>,r=<rounds>,p=1,ss=<salt_separator_b64>,sk=<signer_key_b64>$<salt_b64>$<hash_b64>` (section 3.3).
5. Put the vector into the repository as a fixture, with a comment saying which project it comes from and that the project was deleted. **At least two vectors**, one of them with a password containing non-ASCII characters — the encoding before the KDF is the most likely source of error on import.
6. Counter-check with a wrong password, so that the test also checks the rejection.

*ESTIMATE: steps 1–4 cost about 30 minutes and are one-off; the vector does not go stale as long as Firebase does not change the format.* The same procedure applies correspondingly to the Better Auth scrypt vector (`salt_hex:hash_hex` → `$scrypt$ln=14,r=16,p=1$…`, section 3.3): a throwaway Better Auth project with a known password, a `pg_dump` of the `account` table, and two vectors out of it.

---

### 6.23 Coverage target

**The number: 90 % branch coverage in the directory `core/`, measured with V8 coverage via Vitest, as a blocking threshold on every commit.** For the subdirectories `core/password/`, `core/session/`, `core/token/` and `core/keys/` **100 % branch coverage** applies in addition. For `core/db/`, `core/http/` and `core/plugin/` the same threshold of 90 % applies. For `@velve/auth/import` **85 %** applies, because many branches there handle rare foreign formats that are only reachable through test vectors.

**Why branches and not lines.** Line coverage is almost meaningless in this code base. The verification path from section 3.3 consists of few lines with very many state combinations; a single sign-in covers every line and nevertheless not a single one of the error cases. Branch coverage counts exactly what counts here: that every condition was executed in both directions. The difference is largest at S-ENUM-2 (five account states, one response) and at S-LINK-2 (twelve state combinations, one rule).

**Why 90 % and not 100 %.** The remaining 10 % are in practice three things: error handling for database faults that can only be produced by injection; defensive branches that are unreachable by construction (a `switch` over a string enum with a `default` that throws); and platform-dependent branches (`crypto.subtle` with `@noble/ciphers` as a fallback, section 2.4). Driving these to 100 % produces tests that check doubles instead of behaviour. For the four core directories 100 % nevertheless applies, because every branch there is a security decision and the three categories named do not occur there.

**Mutation testing with Stryker on the crypto path — yes, but limited.** Branch coverage proves that a branch was executed, not that its result is checked. Exactly this gap is dangerous with security code: a test that calls `verify()` and does not evaluate the return value produces full coverage and catches nothing. Mutation testing finds that by turning `===` into `!==`, negating conditions and replacing return values; if a mutant survives, an assertion is missing.

For a one-person team this is **not** worth it **on the whole estate**: a Stryker run over a medium-sized TypeScript estate with integration tests against a real database takes hours, and the majority of the mutants are uninteresting. *ESTIMATE: a full run over `core/` would be at 4–8 hours.* It is worth it **on a narrowly drawn section**:

- **Section:** `core/password/` (procedure switch, PHC parser, rehash policy), `core/token/` (creation and consumption) and `core/keys/` (HKDF derivation, envelope, ring). These are the places where a turned-around condition yields a silent authentication bypass.
- **Only with unit tests as the checkers**, not with the integration tests. *ESTIMATE: with that the runtime falls to 10–20 minutes.*
- **Target: mutation score ≥ 85 % on this section**, measured **before every release**, not on every commit.
- **The value for a one-person team is not the number but the list of surviving mutants.** It is a work list of missing assertions and replaces the code review by a second person at exactly the place where such a review would be worth the most.

**Coverage is not a security measure.** The 127 test cases of this plan are the security measure; the coverage number is only the warning light that shows that a new branch has been added without a test case. No test case of this plan may be dropped with the argument "the coverage is fine, after all".

---

## 7. Decision log

This log is taken over into the repository as `CASE-STUDY.md` and continued there during the build. It is the starting stock, not the result. Every entry records what was decided, what was rejected and why — so that in the end the case study contains the actual reasons and not the ones that tell well afterwards.

Format: **E-nn — Decision.** Context · Rejected · Reason · Price.

---

### Runtime and delivery

**E-01 — Pure TypeScript, no Rust/WASM of our own.**
*Context:* Argon2id is the most expensive computation step of the library.
*Rejected:* (a) A crypto core in Rust, bound in as WASM. (b) `hash-wasm` on the required path.
*Reason:* The gain of a module of our own over ready-made WASM is a factor of 1.6 (47 ms against 76 ms), and the fast way there needs `node:wasi`, `node:worker_threads` and `node:fs` — exactly the modules that are not guaranteed on Caprock. `hash-wasm` fails in Cloudflare Workers with `Wasm code generation disallowed by embedder`. A library whose purpose is independence of place must not bind its core to a form of execution that widespread runtimes forbid.
*Price:* 263 ms instead of 76 ms per password verification in the measurement setup (2 vCPU; lower on server hardware at the same factor). Cushioned by the semaphore from E-13 and by the fact that the compute engine stays exchangeable (E-02).

**E-02 — The Argon2id implementation is exchangeable, because the outputs are bit-identical.**
*Context:* E-01 commits to the slowest variant.
*Rejected:* Wiring the compute engine fixedly into the core.
*Reason:* Measurement shows: `@noble/hashes`, `hash-wasm` and a Rust WASI variant produce byte-identical hashes and verify each other. That makes the choice reversible without a single stored hash being touched. Decision E-01 therefore costs no future.
*Price:* One additional abstraction layer of about thirty lines.

**E-03 — `crypto.subtle` everywhere the primitive already exists there.**
*Context:* PBKDF2, SHA-2, HMAC and AES-GCM lie on the hot path (section 2.7).
*Rejected:* Running everything through `@noble/*` for the sake of uniformity.
*Reason:* PBKDF2 with 600,000 iterations: 269 ms via `crypto.subtle`, 926 ms in JavaScript, **2161 ms via WASM**. SHA-2 on large blocks almost three times as fast. AES-GCM hardware-accelerated. It is non-JavaScript without native bindings — exactly what was sought.
*Price:* Two paths instead of one. `@noble/ciphers` remains as a fallback for incomplete Web Crypto implementations.

**E-04 — ESM only, Node 20 and up only, delivered precompiled.**
*Context:* Delivery form of the npm package (section 2.5).
*Rejected:* Dual output ESM+CJS.
*Reason:* Dual output doubles the test matrix and produces the known dual-package faults. Node 20 makes `crypto`, `crypto.subtle` and `getRandomValues` global — with that every runtime special case falls away.
*Price:* CommonJS users need a dynamic `import()`.

**E-05 — One npm package with subpaths, no monorepo.**
*Context:* One-person team; subpaths per section 3.1.
*Rejected:* Better Auth's cut with 23 packages.
*Reason:* With a one-person team, version drift between one's own packages is the most expensive class of fault: it only occurs at the user and is hard to diagnose there. Heavy dependencies still stay out, because `@velve/auth/import` is loaded only on import.
*Price:* Larger repository, coarser release granularity.

### Database

**E-06 — PostgreSQL only, no query builder, hand-written SQL.**
*Context:* The database layer is, with 58 functions, the largest block of abstraction in Better Auth (section 1 F).
*Rejected:* (a) Adapters for MySQL and SQLite. (b) ORM adapters for Prisma, Drizzle, Kysely.
*Reason:* Better Auth's abstraction pays for portability with the lowest common denominator: `supportsArrays: false` even for PostgreSQL, no partial indexes, no `ON CONFLICT`, no `citext`, one transformation pass per row in JavaScript. The rate limiter there emulates an upsert with up to four round trips that is one statement here. An adapter nobody operates is not reach but an unproven claim.
*Price:* No MySQL, no SQLite, no ORM integration. Whoever needs that takes Better Auth — and that is an honest answer.

**E-07 — Its own Postgres schema `velve`.**
*Context:* The tables lie in the application's database, next to its own.
*Rejected:* Tables with a prefix in the `public` schema.
*Reason:* `user` is a reserved word in SQL; a schema of its own solves the quoting problem and the collision with the application's `users` table in one go. Privilege assignment and backup can be pinned to the schema.
*Price:* The `search_path` has to be right; all queries qualify fully.

**E-08 — Versioned, transactional, forward-directed SQL migrations.**
*Context:* Sixteen tables (section 3.17) that will change across versions.
*Rejected:* Schema derivation at runtime from the configuration, the way Better Auth operates it.
*Reason:* There, `migrate` is only additive, not transactional, knows no version history, cannot rename, drop or retype, does not retrofit indexes on existing columns and works only with Kysely. That is not a migration system but a schema aligner. Delivered SQL can moreover be read, checked and applied with the operator's own tooling.
*Price:* Manual work on every schema change.

### Passwords

**E-09 — Multi-procedure switch in the core, not as a plugin.**
*Context:* Non-negotiable requirement.
*Rejected:* An exchangeable `hash`/`verify` pair as in Better Auth.
*Reason:* There the hook replaces **both** directions. Whoever wants to verify bcrypt necessarily also produces bcrypt — for all users, permanently. That is exactly what the migration guides there recommend verbatim (`docs/.../supabase-migration-guide.mdx:971`, identically in `clerk-migration-guide.mdx:47` and `auth0-migration-guide.mdx:595`), and nobody says alongside it that the target system is thereby permanently fixed to bcrypt(10). Verifying and producing must be separate decisions.
*Price:* Four verifiers in the core that are maintained permanently.

**E-10 — One canonical PHC string, switch on the prefix, no foreign raw format in the database.**
*Context:* Five sources with more than a dozen hash formats (section 4).
*Rejected:* Storing foreign formats and carrying an origin column along.
*Reason:* Better Auth's `salt_hex:hash_hex` carries neither algorithm nor parameters. The consequence is that the scrypt parameters can never be raised without locking out all users — the estate is frozen. A self-describing string makes a parameter change a non-event. For Firebase hashes, GoTrue's existing `$fbscrypt$` format is deliberately adopted instead of one of our own, so that Supabase estates pass through unchanged.
*Price:* The import has to rewrite every source format, not pass it through.

**E-11 — Silent rehash after the response, by compare-and-swap.**
*Context:* `needsRehash` is true after every sign-in with a foreign hash (section 3.3, step 5).
*Rejected:* (a) Rehash synchronously before the response. (b) Rehash in a maintenance run.
*Reason:* Synchronously doubles the sign-in latency to over half a second. A maintenance run is impossible, because the plaintext password only exists at the moment of the sign-in. The write operation `WHERE user_id = $1 AND phc = $alt` is safe against simultaneous sign-ins, and a lost rehash is inconsequential — the next attempt catches it up.
*Price:* A background task whose failure is logged and not reported.

**E-12 — The PHC string is stored encrypted instead of peppered.**
*Context:* Fixed in L-2 (section 3.16); key purpose `password-enc`, column `key_version`, rotation along the path of the rehash.
*Rejected:* A classic pepper in the derivation.
*Reason:* A pepper in the derivation breaks every imported hash, because that one was produced without it. Envelope encryption of the column achieves the same effect — a database dump alone is of no use — and works equally for produced and imported hashes. It is moreover rotatable, which a pepper practically is not.
*Price:* Loss of the key means loss of the passwords. Stands in first place in the operations documentation.

**E-13 — Semaphore over simultaneous KDF calls.**
*Context:* Argon2id occupies 19 MiB per call; the sign-in is reachable unauthenticated.
*Rejected:* No limit, as in Better Auth.
*Reason:* Argon2id with 19 MiB and a hundred simultaneous sign-ins is 1.9 GB. Without a limit the sign-in is itself the attack vector. Better Auth does not even check the input length at `/sign-in/email` before the KDF call and hashes even for an unknown address (`api/routes/sign-in.ts:526-539`); `/change-password` even hashes the new password **before** verifying the old one (`api/routes/update-user.ts:276-277`). The length check before the KDF follows L-7: at least 8 characters, at most 4096 bytes, no composition rules; a comparison against leak corpora hangs on `password.validate` and never runs at sign-in.
*Price:* Under load the sign-in waits instead of failing — up to the wait limit of 5 seconds (L-1).

**E-14 — No response deadline.**
*Context:* Enumeration protection through timing behaviour (section 3.13, L-1).
*Rejected:* A fixed minimum duration per endpoint, as Better Auth applies it with 500 ms at `send-verification-email`.
*Reason:* A deadline conceals non-uniformity instead of preventing it, and leaks again above the threshold. The rule "one code path, the same work independent of the result" is stronger and provable in the test.
*Price:* The proof is a statistical test that has to be maintained in CI. Separate from that remains the semaphore's wait limit of 5 seconds — a resource limit, not a timing equalisation (L-1).

### Identity

**E-15 — Three identity configurations as a discriminated union, materialised as a CHECK constraint.**
*Context:* `email`, `username`, `username_email` (section 3.4).
*Rejected:* Making all fields always optional and checking at runtime.
*Reason:* If the configuration determines the type, `auth.username.changeUsername` does not exist in the configuration `email` — the error occurs at compile time, not at the user. The constraint ensures that even a direct database access does not break the invariant.
*Price:* A change of the configuration after the introduction is a real migration.

**E-16 — The email is nowhere mandatory and is nowhere invented.**
*Context:* `velve.user.email` is nullable (section 3.2).
*Rejected:* Better Auth's way: `email NOT NULL UNIQUE` plus placeholder addresses.
*Reason:* There this is not a documentation recommendation but built-in production code — `createPlaceholderEmail` is called by Roblox, TikTok, WeChat, Reddit, Twitter, SIWE, Anonymous and the Entra helper and produces addresses like `<id>@<ns>.placeholder.invalid` that no plugin can ever send anything to. Issue #9124 is open on it, the documentation admits it (`concepts/oauth.mdx:409`). An invalid address in the database is worse than none at all, because downstream systems take it for real.
*Price:* Every code path has to withstand `email IS NULL`.

**E-17 — Usernames: display form and comparison form separated, with a character allowlist.**
*Context:* The username is the sign-in name in two of the three configurations.
*Rejected:* Only one column, lowercased.
*Reason:* An allowlist is the most effective homoglyph protection, because it does not let the problem arise in the first place; skeleton formation according to Unicode confusables would be the more laborious and more error-prone alternative. The separate display form preserves the spelling the user chose.
*Price:* Non-Latin usernames are excluded by default. The allowlist is configurable, with a documented warning.

**E-18 — In the configuration `username` there is no reset by email, and that is a start error without recovery codes.**
*Context:* Configuration `username` without a mailbox (section 3.4).
*Rejected:* — There is no second channel the library could invent.
*Reason:* Without a mailbox there is no channel outside the password. That cannot be configured away, only named honestly. The library refuses to start instead of leaving the gap open.
*Price:* A mandatory option that has to be explained.

**E-19 — Usernames are enumerable, and that is said.**
*Context:* Availability check at registration.
*Rejected:* Not offering the check.
*Reason:* Whoever offers an availability check reveals the existence — no wording changes that. Not offering it makes registration forms unusable. So: offer it, limit it hard, document it. Email enumeration stays completely closed.
*Price:* A limitation in the data sheet instead of a silent gap.

### Sessions

**E-20 — Database sessions, opaque token, only `sha256` stored.**
*Context:* Immediate revocation is the core promise of the session model (section 3.5).
*Rejected:* (a) JWT with refresh rotation. (b) Plaintext token in the database, as Better Auth does it.
*Reason:* Immediate revocation is the property at stake; JWT cannot deliver it in principle, and the reuse detection for it is a class of fault of its own — Better Auth's own OAuth server got it wrong twice (GHSA-7w99-5wm4-3g79, GHSA-392p-2q2v-4372). The plaintext token there is an unnecessary disclosure: the server only compares, so the hash suffices. It is remarkable that the same code base does know a hashing option for `verification.identifier`.
*Price:* One indexed database hit per request. With a unique index on 32 bytes that is the cheapest query in the system. The row keeps `ip` and `user_agent` truncated by default — `/24` resp. `/64`, browser and system family (L-10); whoever needs the full value switches it on.

**E-21 — No cookie cache, in no variant.**
*Context:* The database hit from E-20 is the place where a cache beckons.
*Rejected:* Signed cookie, JWE cookie, Redis cache.
*Reason:* The gravest published fault in Better Auth hangs on exactly that: GHSA-xg6x-h9c9-2m83, CVSS 9.1 — the cookie cache stored the session before the second factor had been verified, and thereby bypassed 2FA completely. On top of that, revoked sessions live on in the cache until expiry, and the default value `compact` stores session and user including the address **unencrypted** in the browser. A cache may hold data, never an authorisation decision. For the same reason every handler sets `Cache-Control: no-store` and `Vary: Cookie` (L-6) — an upstream CDN is the normal case, and no response of the library may be left lying there either.
*Price:* One database hit per request remains.

**E-22 — Two deadlines: idle and absolute.**
*Context:* Lifetime of a session (section 3.5).
*Rejected:* A sliding window as at Better Auth and NextAuth.
*Reason:* A purely sliding window never expires as long as somebody is using it — an attacker too. The absolute deadline limits the damage of a stolen token without anyone's involvement.
*Price:* Users sign in again at fixed intervals.

**E-23 — Reissue on every trust change, always as an insert plus a delete in one transaction.**
*Context:* Sign-in, second factor, password change and linking change the trust level.
*Rejected:* Rewriting the existing row by `UPDATE`.
*Reason:* `UPDATE session SET user_id` does not exist and is prevented by a lint rule **and** a database trigger. Two locks against the same class of fault are appropriate here, because its occurrence goes unnoticed.
*Price:* Somewhat more write load at sign-in.

**E-24 — Password change and reset revoke other sessions. Without a switch.**
*Context:* A reset is mostly the reaction to a suspicion.
*Rejected:* An option with a safe default value.
*Reason:* In Better Auth, `revokeSessionsOnPasswordReset` is an option without a default value (`api/routes/password.ts:328-330`). A reset that leaves the attacker's sessions standing does not fulfil its purpose — and the evaluation of the 33 advisories shows: almost every critical rating hung on a default setting, not on a bug.
*Price:* None that would be worth it.

### Second factor

**E-25 — The intermediate state is a table of its own, not a session, and reaches exactly four routes.**
*Context:* The moment between the correct password and the second factor (section 3.6).
*Rejected:* A session with the marking "second factor pending".
*Reason:* Here Better Auth got it right — a cookie of its own plus a verification row instead of a session — and that is expressly adopted. The addition is the restriction to exactly the four routes with `caller: "pending"`: otherwise the intermediate state is half an identity card that is somewhere read as a whole one. After five failed attempts the row is deleted and the process starts again at the password; no account lockout (L-8).
*Price:* One more table.

**E-26 — WebAuthn is a sign-in path of its own, and synchronised passkeys are distinguishable from device-bound ones.**
*Context:* Passkey sign-in without a password and WebAuthn as a second factor (section 3.6).
*Rejected:* WebAuthn only as a second factor; discarding the flags.
*Reason:* The flags `backupEligible` and `backupState` arrive in the authenticator data anyway; not storing them would be a loss of information without a counter-value. They are stored and passed on — a policy on top of that is the application's business, not the library's. By the same logic a regressing `sign_count` is reported as the field `signCountRegressed`, not rejected: synchronised passkeys do not keep the counter reliably (L-9). And because WebAuthn is a sign-in path of its own, it counts among the paths whose last one may not be removed — the attempt fails with `last_sign_in_method` (L-13).
*Price:* Two columns and a pair of terms in the documentation that needs explaining.

**E-27 — Recovery codes: 160 bit, stored as HMAC, lookup instead of iteration.**
*Context:* Ten codes per user; in the configuration `username` the only way back into the account.
*Rejected:* Argon2id on every code.
*Reason:* At 160 bit of entropy from a CSPRNG a memory-hard derivation brings nothing — there is no dictionary. It would however force ten KDF calls per verification if the codes are iterated over. The HMAC allows the direct index hit. Every row carries `key_version`, so that a rotation of `token-pepper` does not devalue the codes (L-3).
*Price:* The rationale has to be in the documentation, otherwise it reads like negligence.

**E-28 — TOTP replay via `PRIMARY KEY (user_id, time_step)`.**
*Context:* Tolerance ±1 step (section 3.6); a code may be valid only once within the window.
*Rejected:* Reading and inserting as two statements.
*Reason:* The insert attempt **is** the check. That is race-free without a lock and without an additional query.
*Price:* A table that has to be cleaned up — via `auth.maintenance.sweep()` or the SQL delivered with it, not via a timer in the core (L-11).

### Third parties

**E-29 — `(provider, subject)` is the only linking key. The email is never one.**
*Context:* Provider linking (section 3.10) and import (section 4.0.6).
*Rejected:* Linking via email equality, even with a verified provider address.
*Reason:* This is the most frequent grave class of fault of all: CVE-2026-53516 (CVSS 8.3), GHSA-qq9h-g4jm-xgf3 (8.3), GHSA-fmh4-wcc4-5jm3 (7.7) — three times the same cause in one code base. Automatic linking happens only if the provider reports the address as verified **and** the local account is verified **and** the provider is configured as trusted. Three conditions, all three necessary. The same rule applies inwards: if an address is confirmed for the first time and the existing password comes from a different session than the one now confirming, the password sign-in is deleted and every session revoked (L-12) — otherwise an attacker's advance access stays valid, exactly the fault from GHSA-qq9h-g4jm-xgf3.
*Price:* More explicit linking in the user flow.

**E-30 — Fourteen providers instead of thirty-six.**
*Context:* Provider list at launch (section 3.10).
*Rejected:* Drawing level with Better Auth's provider list.
*Reason:* The interface is the value, not the number. Providers are the part that can be caught up on most cheaply later — and every single one is a maintenance load when its OAuth behaviour changes. Better Auth's provider abstraction is, by the way, the cleanest corner of its code base and serves as the model here.
*Price:* A shorter list on the product page.

**E-31 — Foreign tokens are not stored by default.**
*Context:* Access, refresh and ID tokens of the providers after the sign-in.
*Rejected:* Storing as the default, encrypted.
*Reason:* What is not stored cannot leak. Most applications do not need a provider token after the sign-in; whoever needs it switches it on and gets it encrypted.
*Price:* An option that some overlook and then go looking for.

### Extensibility

**E-32 — Enumerated extension points instead of open extensibility.**
*Context:* Plugin interface (section 3.11).
*Rejected:* Better Auth's model, in which a plugin can override core endpoints, mutate the context by `Object.assign`, replace `password.hash` and write the options of foreign plugins.
*Reason:* There this is not a theoretical possibility: the Stripe plugin actually writes into the options of the Organization plugin (`packages/stripe/src/index.ts:256`) and thereby produces an invisible order dependency. Collisions are only logged, `init` runs without `try/catch`, and `plugin.migrations` as well as `plugin.adapter` are dead code. A plugin is a listener with a right of veto, not a co-owner.
*Price:* Many a plugin that would be possible there is impossible here. That is intended.

**E-33 — A name collision is a start error.**
*Context:* Two plugins, or a plugin and the core, claim the same route or table name.
*Rejected:* A warning in the log, as Better Auth does it.
*Reason:* A warning in the log is not read in operation. An error at start is read.
*Price:* Less leniency at the introduction.

**E-34 — One route declaration produces handler, server method and client.**
*Context:* Client and server must know the same surface (section 3.12).
*Rejected:* Better Auth's runtime proxy over path segments with the heuristic "body present, so POST".
*Reason:* There is no runtime contract between client and server there; the types arise purely statically from `Auth["api"]`, which leads to the known inference problems (issues #1252, #4654 with TS2742, #5159). Derived from one declaration, a call that does not exist cannot compile.
*Price:* A declaration layer that has to be maintained.

### Scope

**E-35 — No roles, no permissions, no organisations.**
*Context:* Specification of the client.
*Rejected:* Roles and organisations as an optional module in the same package.
*Reason:* The numbers support it: in Better Auth, 133 of 618 functions fall to authorisation and identity-provider roles (section 1 I and J); the documentation of the Organization plugin alone comprises 2586 lines. That is a product of its own that only happens to live in the same package. The library answers who is signed in — what that person may do is known only to the application.
*Price:* Whoever wants both needs two things. That is the right number.

**E-36 — 322 of 618 functions are left out.**
*Context:* Result of the function comparison (section 1).
*Rejected:* Function parity with Better Auth as a goal.
*Reason:* Not as an economy measure, but because 133 of them lie outside the purpose, 32 fall to session variants that contradict the revocation promise, and 28 to database abstraction that falls away with the commitment to PostgreSQL. 268 are adopted or solved differently, 28 exceeded.
*Price:* Velve Auth is not a replacement for every Better Auth deployment. Where it is one, it is a better one.

**E-37 — No email sending, no audit log, no admin interface.**
*Context:* Operational functions around the sign-in (section 3.14).
*Rejected:* Built-in sending, an audit table in the schema, a delivered interface.
*Reason:* Sending is a callback, because every serious application already has a sending path and the library should not get in the way there. Audit log and interface belong to the application, which knows the domain context. Better Auth likewise has neither in the open part — there, however, because they are paid products.
*Price:* More work at integration.

### Migration

**E-38 — Migration is a core function with a dry run, not a guide in the wiki.**
*Context:* Five sources as a specification of the client (section 4).
*Rejected:* Guides with an example script, as Better Auth delivers them.
*Reason:* Better Auth has five guides; the three that concern passwords all recommend the same thing — switch globally to bcrypt(10) — and for Firebase, the only source with a non-trivial hash, there is none at all. An import without a prior dry run is a blind flight: which procedures lie in the estate is not known beforehand.
*Price:* The most laborious individual building block after the core.

**E-39 — md4, md5, sha1 and raw HMAC are not verified.**
*Context:* Auth0's `custom_password_hash` and Clerk's `password_hasher` can contain such procedures (sections 4.2 d and 4.3 d).
*Rejected:* One-time verification with an immediate rehash.
*Reason:* That would create permanent legacy surface in the core for hashes that are effectively plaintext — and the one-time character could not be enforced. The rule is: no procedure that neither iterates nor is memory-hard; it also hits `sha256`, `sha512` and `ldap` at Auth0 as well as ten of the nineteen Clerk procedures. Those affected get the reset path (E-41).
*Price:* In an Auth0 migration with an old estate these users have to set their password anew.

**E-40 — No automatic merge on a collision.**
*Context:* Two source accounts with the same email (section 4.0.6).
*Rejected:* Merging; "oldest account wins" only on an explicit instruction (`skip-duplicates`).
*Reason:* When merging two source accounts with the same address, only one password hash survives — that is a privilege escalation through migration and breaks the same rule that E-29 sets up for OAuth.
*Price:* Collisions abort the run and have to be decided.

**E-41 — Unverifiable hashes lead to a reset obligation in a table of its own, not to a sentinel in the PHC field.**
*Context:* Reset path for users without a usable hash (section 4.0.5).
*Rejected:* A placeholder value in `password_credential.phc`.
*Reason:* A sentinel value would have forced a further prefix line in the switch and thereby extended the verification path by a special case that is not a hash. The response at sign-in stays byte-for-byte identical; the hint moves into the email.
*Price:* A table and an additional query in the error branch.

### Security by default

**E-42 — Every security-relevant setting is safe in its default value.**
*Context:* Better Auth's advisory history (section 5).
*Rejected:* Convenient defaults with security options to switch on.
*Reason:* The evaluation of the 33 advisories yields: the most frequent cause is not a crypto weakness but a missing owner check (10 cases), and almost every critical rating hung on a default setting. A weakening must be explicit, logged and visible at start.
*Price:* Less convenience at the introduction.

**E-43 — Every repository method on user-bound tables demands an `actor`.**
*Context:* Ten of 33 advisories of the class "missing owner binding".
*Rejected:* Owner checking in the handler, enforced by review.
*Reason:* The ten advisories of the class "missing owner binding" have the same shape: a missing line `AND user_id = :actor`. If the signature forces the caller to name the acting party, it cannot be forgotten — it can only be given wrongly, and that is a visible error instead of an invisible one.
*Price:* Somewhat more typing in the core.

**E-44 — Purpose-separated keys via HKDF, the version in the envelope of every produced value.**
*Context:* Six key purposes (section 3.8).
*Rejected:* One secret for everything, as Better Auth does it.
*Reason:* There `ctx.secret` signs cookies, email JWTs and the cache HMAC; rotation is implemented only for encryption, signatures do not rotate, and a change of secret devalues all sessions and all open links at the same time. Here every rotation survives all sessions, because sessions are opaque database rows and are connected to no key. Where no envelope exists, the version stands as a column: `password_credential.key_version` for `password-enc` (L-2) and `recovery_code.key_version` for `token-pepper` (L-3).
*Price:* A key ring that wants managing.

**E-45 — The `__Host-` prefix for all cookies of the library.**
*Context:* `__Host-velve_session` and `__Host-velve_pending` (sections 3.5, 3.6).
*Rejected:* `__Secure-` with a configurable `Domain`.
*Reason:* The prefix makes the browser enforce `Secure` and `Path=/` and forbid `Domain` — cookie tossing from a taken-over subdomain is thereby ruled out. Better Auth defines the prefix (`cookies/cookie-utils.ts:35`) but never sets it — `cookies/index.ts:75` only chooses between `__Secure-` and no prefix.
*Price:* No `Domain` scope, so cross-subdomain needs a token exchange instead of a shared cookie.

**E-46 — Enumeration protection is the default value and lies in one place.**
*Context:* Sign-in, registration, reset and email change (section 3.13).
*Rejected:* Protection per endpoint, retrofittable.
*Reason:* In Better Auth it was reported afterwards four times individually (#7972, #7944, #5017, #8096), does not take effect in the standard setup even in 1.7.3, and `/sign-up/email` logs the address in plaintext while returning 422. Retrofitted protection is patchy protection. Two consequences follow from that: "account disabled" is invisible at sign-in and appears only on the resolution of an existing session (L-4); and the account-related counter is formed on the identifier, not on the account ID, so that it takes effect before the user resolution and treats existing and non-existent accounts alike — exceeding it rejects instead of delaying, because a delay would be a timing channel (L-5). For the same reason there is no `requireEmailVerification`: a sign-in block for unconfirmed accounts would be an enumeration channel and at the same time a dead end, because `email.requestVerification` demands a session. Sign-in and registration always deliver a session, `User.emailVerifiedAt` carries the state, the application decides (section 1, A5; S-TIM-7).
*Price:* Error messages are less convenient for developers. The true reason is in the server log.
