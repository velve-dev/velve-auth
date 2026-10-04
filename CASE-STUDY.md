# Velve Auth — Case Study

Velve Auth is an authentication library for TypeScript and PostgreSQL that answers exactly one question: who is signed in. It runs inside the application's own process and keeps its users in the application's own database, so no third-party authentication service sits between an application and the people who use it. It exists because most authentication libraries also answer what a user may do and which organisation they belong to, and those answers belong to the application, because only the application knows what its permissions mean. What is left once those questions are refused is small enough to be read end to end, and the parts that matter are the ones that are usually wrong: the upgrade path for imported password hashes, resistance to account enumeration, secrets at rest and second factors. This document is the case study of how it was built. Every decision was written down while it was being taken, with what was rejected, the reason and the price, and where a decision was taken for a bad reason, the bad reason is what was kept. The complete record has more than twelve hundred entries and lives in [`docs/decisions/log.md`](./docs/decisions/log.md). What follows is a selection: the 46 decisions the specification started from, and thirteen entries from the build, twelve of which carry a measurement, a fault that was found, or an assumption that turned out to be wrong, and one of which, E-223, records a decision taken against a fault before anyone hit it. Every entry keeps its number, so E-186 here is E-186 in the log and in the code comment that cites it, and an entry about code ends with the file and the symbol it concerns. The specification's decisions are quoted from its English translation, and the one build entry first written in German is translated word for word, with the original kept in the log.

---

## The decisions the specification started from

### Runtime and delivery

<a id="e-01"></a>

**E-01 — Pure TypeScript, no Rust/WASM of our own.**
*Context:* Argon2id is the most expensive computation step of the library.
*Rejected:* (a) A crypto core in Rust, bound in as WASM. (b) `hash-wasm` on the required path.
*Reason:* The gain of a module of our own over ready-made WASM is a factor of 1.6 (47 ms against 76 ms), and the fast way there needs `node:wasi`, `node:worker_threads` and `node:fs` — exactly the modules that are not guaranteed on Caprock. `hash-wasm` fails in Cloudflare Workers with `Wasm code generation disallowed by embedder`. A library whose purpose is independence of place must not bind its core to a form of execution that widespread runtimes forbid.
*Price:* 263 ms instead of 76 ms per password verification in the measurement setup (2 vCPU; lower on server hardware at the same factor). Cushioned by the semaphore from E-13 and by the fact that the compute engine stays exchangeable (E-02).

<a id="e-02"></a>

**E-02 — The Argon2id implementation is exchangeable, because the outputs are bit-identical.**
*Context:* E-01 commits to the slowest variant.
*Rejected:* Wiring the compute engine fixedly into the core.
*Reason:* Measurement shows: `@noble/hashes`, `hash-wasm` and a Rust WASI variant produce byte-identical hashes and verify each other. That makes the choice reversible without a single stored hash being touched. Decision E-01 therefore costs no future.
*Price:* One additional abstraction layer of about thirty lines.
*Where:* [`src/core/password/argon2.ts`](./src/core/password/argon2.ts) `selectArgon2Engine`

<a id="e-03"></a>

**E-03 — `crypto.subtle` everywhere the primitive already exists there.**
*Context:* PBKDF2, SHA-2, HMAC and AES-GCM lie on the hot path (section 2.7).
*Rejected:* Running everything through `@noble/*` for the sake of uniformity.
*Reason:* PBKDF2 with 600,000 iterations: 269 ms via `crypto.subtle`, 926 ms in JavaScript, **2161 ms via WASM**. SHA-2 on large blocks almost three times as fast. AES-GCM hardware-accelerated. It is non-JavaScript without native bindings — exactly what was sought.
*Price:* Two paths instead of one. `@noble/ciphers` remains as a fallback for incomplete Web Crypto implementations.
*Where:* [`src/core/keys/aes-gcm.ts`](./src/core/keys/aes-gcm.ts) `selectAesGcmEngine`

<a id="e-04"></a>

**E-04 — ESM only, Node 20 and up only, delivered precompiled.**
*Context:* Delivery form of the npm package (section 2.5).
*Rejected:* Dual output ESM+CJS.
*Reason:* Dual output doubles the test matrix and produces the known dual-package faults. Node 20 makes `crypto`, `crypto.subtle` and `getRandomValues` global — with that every runtime special case falls away.
*Price:* CommonJS users need a dynamic `import()`.

<a id="e-05"></a>

**E-05 — One npm package with subpaths, no monorepo.**
*Context:* One-person team; subpaths per section 3.1.
*Rejected:* Better Auth's cut with 23 packages.
*Reason:* With a one-person team, version drift between one's own packages is the most expensive class of fault: it only occurs at the user and is hard to diagnose there. Heavy dependencies still stay out, because `@velve/auth/import` is loaded only on import.
*Price:* Larger repository, coarser release granularity.

### Database

<a id="e-06"></a>

**E-06 — PostgreSQL only, no query builder, hand-written SQL.**
*Context:* The database layer is, with 58 functions, the largest block of abstraction in Better Auth (section 1 F).
*Rejected:* (a) Adapters for MySQL and SQLite. (b) ORM adapters for Prisma, Drizzle, Kysely.
*Reason:* Better Auth's abstraction pays for portability with the lowest common denominator: `supportsArrays: false` even for PostgreSQL, no partial indexes, no `ON CONFLICT`, no `citext`, one transformation pass per row in JavaScript. The rate limiter there emulates an upsert with up to four round trips that is one statement here. An adapter nobody operates is not reach but an unproven claim.
*Price:* No MySQL, no SQLite, no ORM integration. Whoever needs that takes Better Auth — and that is an honest answer.
*Where:* [`src/core/db/driver.ts`](./src/core/db/driver.ts) `Driver`

<a id="e-07"></a>

**E-07 — Its own Postgres schema `velve`.**
*Context:* The tables lie in the application's database, next to its own.
*Rejected:* Tables with a prefix in the `public` schema.
*Reason:* `user` is a reserved word in SQL; a schema of its own solves the quoting problem and the collision with the application's `users` table in one go. Privilege assignment and backup can be pinned to the schema.
*Price:* The `search_path` has to be right; all queries qualify fully.
*Where:* [`src/core/db/schema-rewrite.ts`](./src/core/db/schema-rewrite.ts) `applySchemaName`

<a id="e-08"></a>

**E-08 — Versioned, transactional, forward-directed SQL migrations.**
*Context:* Sixteen tables (section 3.17) that will change across versions.
*Rejected:* Schema derivation at runtime from the configuration, the way Better Auth operates it.
*Reason:* There, `migrate` is only additive, not transactional, knows no version history, cannot rename, drop or retype, does not retrofit indexes on existing columns and works only with Kysely. That is not a migration system but a schema aligner. Delivered SQL can moreover be read, checked and applied with the operator's own tooling.
*Price:* Manual work on every schema change.
*Where:* [`src/core/db/migration-runner.ts`](./src/core/db/migration-runner.ts) `runMigrations`

### Passwords

<a id="e-09"></a>

**E-09 — Multi-procedure switch in the core, not as a plugin.**
*Context:* Non-negotiable requirement.
*Rejected:* An exchangeable `hash`/`verify` pair as in Better Auth.
*Reason:* There the hook replaces **both** directions. Whoever wants to verify bcrypt necessarily also produces bcrypt — for all users, permanently. That is exactly what the migration guides there recommend verbatim (`docs/.../supabase-migration-guide.mdx:971`, identically in `clerk-migration-guide.mdx:47` and `auth0-migration-guide.mdx:595`), and nobody says alongside it that the target system is thereby permanently fixed to bcrypt(10). Verifying and producing must be separate decisions.
*Price:* Four verifiers in the core that are maintained permanently.
*Where:* [`src/core/password/scheme.ts`](./src/core/password/scheme.ts) `LEGACY_SCHEMES`

<a id="e-10"></a>

**E-10 — One canonical PHC string, switch on the prefix, no foreign raw format in the database.**
*Context:* Five sources with more than a dozen hash formats (section 4).
*Rejected:* Storing foreign formats and carrying an origin column along.
*Reason:* Better Auth's `salt_hex:hash_hex` carries neither algorithm nor parameters. The consequence is that the scrypt parameters can never be raised without locking out all users — the estate is frozen. A self-describing string makes a parameter change a non-event. For Firebase hashes, GoTrue's existing `$fbscrypt$` format is deliberately adopted instead of one of our own, so that Supabase estates pass through unchanged.
*Price:* The import has to rewrite every source format, not pass it through.
*Where:* [`src/core/password/phc.ts`](./src/core/password/phc.ts) `parsePhc`

<a id="e-11"></a>

**E-11 — Silent rehash after the response, by compare-and-swap.**
*Context:* `needsRehash` is true after every sign-in with a foreign hash (section 3.3, step 5).
*Rejected:* (a) Rehash synchronously before the response. (b) Rehash in a maintenance run.
*Reason:* Synchronously doubles the sign-in latency to over half a second. A maintenance run is impossible, because the plaintext password only exists at the moment of the sign-in. The write operation `WHERE user_id = $1 AND phc = $alt` is safe against simultaneous sign-ins, and a lost rehash is inconsequential — the next attempt catches it up.
*Price:* A background task whose failure is logged and not reported.
*Where:* [`src/core/password/credential.ts`](./src/core/password/credential.ts) `replaceIfUnchanged`

<a id="e-12"></a>

**E-12 — The PHC string is stored encrypted instead of peppered.**
*Context:* Fixed in L-2 (section 3.16); key purpose `password-enc`, column `key_version`, rotation along the path of the rehash.
*Rejected:* A classic pepper in the derivation.
*Reason:* A pepper in the derivation breaks every imported hash, because that one was produced without it. Envelope encryption of the column achieves the same effect — a database dump alone is of no use — and works equally for produced and imported hashes. It is moreover rotatable, which a pepper practically is not.
*Price:* Loss of the key means loss of the passwords. Stands in first place in the operations documentation.
*Where:* [`src/core/password/credential.ts`](./src/core/password/credential.ts) `sealPhc`

<a id="e-13"></a>

**E-13 — Semaphore over simultaneous KDF calls.**
*Context:* Argon2id occupies 19 MiB per call; the sign-in is reachable unauthenticated.
*Rejected:* No limit, as in Better Auth.
*Reason:* Argon2id with 19 MiB and a hundred simultaneous sign-ins is 1.9 GB. Without a limit the sign-in is itself the attack vector. Better Auth does not even check the input length at `/sign-in/email` before the KDF call and hashes even for an unknown address (`api/routes/sign-in.ts:526-539`); `/change-password` even hashes the new password **before** verifying the old one (`api/routes/update-user.ts:276-277`). The length check before the KDF follows L-7: at least 8 characters, at most 4096 bytes, no composition rules; a comparison against leak corpora hangs on `password.validate` and never runs at sign-in.
*Price:* Under load the sign-in waits instead of failing — up to the wait limit of 5 seconds (L-1).
*Where:* [`src/core/password/semaphore.ts`](./src/core/password/semaphore.ts) `createKdfSemaphore`

<a id="e-14"></a>

**E-14 — No response deadline.**
*Context:* Enumeration protection through timing behaviour (section 3.13, L-1).
*Rejected:* A fixed minimum duration per endpoint, as Better Auth applies it with 500 ms at `send-verification-email`.
*Reason:* A deadline conceals non-uniformity instead of preventing it, and leaks again above the threshold. The rule "one code path, the same work independent of the result" is stronger and provable in the test.
*Price:* The proof is a statistical test that has to be maintained in CI. Separate from that remains the semaphore's wait limit of 5 seconds — a resource limit, not a timing equalisation (L-1).
*Where:* [`src/core/password/semaphore.ts`](./src/core/password/semaphore.ts) `createKdfSemaphore`

### Identity

<a id="e-15"></a>

**E-15 — Three identity configurations as a discriminated union, materialised as a CHECK constraint.**
*Context:* `email`, `username`, `username_email` (section 3.4).
*Rejected:* Making all fields always optional and checking at runtime.
*Reason:* If the configuration determines the type, `auth.username.changeUsername` does not exist in the configuration `email` — the error occurs at compile time, not at the user. The constraint ensures that even a direct database access does not break the invariant.
*Price:* A change of the configuration after the introduction is a real migration.
*Where:* [`src/core/db/migrations/identity-mode.ts`](./src/core/db/migrations/identity-mode.ts) `user_identity_mode`

<a id="e-16"></a>

**E-16 — The email is nowhere mandatory and is nowhere invented.**
*Context:* `velve.user.email` is nullable (section 3.2).
*Rejected:* Better Auth's way: `email NOT NULL UNIQUE` plus placeholder addresses.
*Reason:* There this is not a documentation recommendation but built-in production code — `createPlaceholderEmail` is called by Roblox, TikTok, WeChat, Reddit, Twitter, SIWE, Anonymous and the Entra helper and produces addresses like `<id>@<ns>.placeholder.invalid` that no plugin can ever send anything to. Issue #9124 is open on it, the documentation admits it (`concepts/oauth.mdx:409`). An invalid address in the database is worse than none at all, because downstream systems take it for real.
*Price:* Every code path has to withstand `email IS NULL`.
*Where:* [`src/core/identity/columns.ts`](./src/core/identity/columns.ts) `resolveEmailColumn`

<a id="e-17"></a>

**E-17 — Usernames: display form and comparison form separated, with a character allowlist.**
*Context:* The username is the sign-in name in two of the three configurations.
*Rejected:* Only one column, lowercased.
*Reason:* An allowlist is the most effective homoglyph protection, because it does not let the problem arise in the first place; skeleton formation according to Unicode confusables would be the more laborious and more error-prone alternative. The separate display form preserves the spelling the user chose.
*Price:* Non-Latin usernames are excluded by default. The allowlist is configurable, with a documented warning.
*Where:* [`src/core/identity/fold.ts`](./src/core/identity/fold.ts) `comparisonFormOf`

<a id="e-18"></a>

**E-18 — In the configuration `username` there is no reset by email, and that is a start error without recovery codes.**
*Context:* Configuration `username` without a mailbox (section 3.4).
*Rejected:* — There is no second channel the library could invent.
*Reason:* Without a mailbox there is no channel outside the password. That cannot be configured away, only named honestly. The library refuses to start instead of leaving the gap open.
*Price:* A mandatory option that has to be explained.
*Where:* [`src/core/factor/recovery/startup.ts`](./src/core/factor/recovery/startup.ts) `assertRecoveryCodesAreConfigured`

<a id="e-19"></a>

**E-19 — Usernames are enumerable, and that is said.**
*Context:* Availability check at registration.
*Rejected:* Not offering the check.
*Reason:* Whoever offers an availability check reveals the existence — no wording changes that. Not offering it makes registration forms unusable. So: offer it, limit it hard, document it. Email enumeration stays completely closed.
*Price:* A limitation in the data sheet instead of a silent gap.
*Where:* [`src/core/identity/resolution.ts`](./src/core/identity/resolution.ts) `usernameAvailability`

### Sessions

<a id="e-20"></a>

**E-20 — Database sessions, opaque token, only `sha256` stored.**
*Context:* Immediate revocation is the core promise of the session model (section 3.5).
*Rejected:* (a) JWT with refresh rotation. (b) Plaintext token in the database, as Better Auth does it.
*Reason:* Immediate revocation is the property at stake; JWT cannot deliver it in principle, and the reuse detection for it is a class of fault of its own — Better Auth's own OAuth server got it wrong twice (GHSA-7w99-5wm4-3g79, GHSA-392p-2q2v-4372). The plaintext token there is an unnecessary disclosure: the server only compares, so the hash suffices. It is remarkable that the same code base does know a hashing option for `verification.identifier`.
*Price:* One indexed database hit per request. With a unique index on 32 bytes that is the cheapest query in the system. The row keeps `ip` and `user_agent` truncated by default — `/24` resp. `/64`, browser and system family (L-10); whoever needs the full value switches it on.
*Where:* [`src/core/session/token.ts`](./src/core/session/token.ts) `createSessionToken`

<a id="e-21"></a>

**E-21 — No cookie cache, in no variant.**
*Context:* The database hit from E-20 is the place where a cache beckons.
*Rejected:* Signed cookie, JWE cookie, Redis cache.
*Reason:* The gravest published fault in Better Auth hangs on exactly that: GHSA-xg6x-h9c9-2m83, CVSS 9.1 — the cookie cache stored the session before the second factor had been verified, and thereby bypassed 2FA completely. On top of that, revoked sessions live on in the cache until expiry, and the default value `compact` stores session and user including the address **unencrypted** in the browser. A cache may hold data, never an authorisation decision. For the same reason every handler sets `Cache-Control: no-store` and `Vary: Cookie` (L-6) — an upstream CDN is the normal case, and no response of the library may be left lying there either.
*Price:* One database hit per request remains.

<a id="e-22"></a>

**E-22 — Two deadlines: idle and absolute.**
*Context:* Lifetime of a session (section 3.5).
*Rejected:* A sliding window as at Better Auth and NextAuth.
*Reason:* A purely sliding window never expires as long as somebody is using it — an attacker too. The absolute deadline limits the damage of a stolen token without anyone's involvement.
*Price:* Users sign in again at fixed intervals.
*Where:* [`src/core/session/config.ts`](./src/core/session/config.ts) `DEFAULT_SESSION_CONFIG`

<a id="e-23"></a>

**E-23 — Reissue on every trust change, always as an insert plus a delete in one transaction.**
*Context:* Sign-in, second factor, password change and linking change the trust level.
*Rejected:* Rewriting the existing row by `UPDATE`.
*Reason:* `UPDATE session SET user_id` does not exist and is prevented by a lint rule **and** a database trigger. Two locks against the same class of fault are appropriate here, because its occurrence goes unnoticed.
*Price:* Somewhat more write load at sign-in.
*Where:* [`src/core/db/migrations/initial-schema.ts`](./src/core/db/migrations/initial-schema.ts) `session_user_id_immutable`

<a id="e-24"></a>

**E-24 — Password change and reset revoke other sessions. Without a switch.**
*Context:* A reset is mostly the reaction to a suspicion.
*Rejected:* An option with a safe default value.
*Reason:* In Better Auth, `revokeSessionsOnPasswordReset` is an option without a default value (`api/routes/password.ts:328-330`). A reset that leaves the attacker's sessions standing does not fulfil its purpose — and the evaluation of the 33 advisories shows: almost every critical rating hung on a default setting, not on a bug.
*Price:* None that would be worth it.
*Where:* [`src/core/session/service.ts`](./src/core/session/service.ts) `reissueAfterCredentialChange`

### Second factor

<a id="e-25"></a>

**E-25 — The intermediate state is a table of its own, not a session, and reaches exactly four routes.**
*Context:* The moment between the correct password and the second factor (section 3.6).
*Rejected:* A session with the marking "second factor pending".
*Reason:* Here Better Auth got it right — a cookie of its own plus a verification row instead of a session — and that is expressly adopted. The addition is the restriction to exactly the four routes with `caller: "pending"`: otherwise the intermediate state is half an identity card that is somewhere read as a whole one. After five failed attempts the row is deleted and the process starts again at the password; no account lockout (L-8).
*Price:* One more table.
*Where:* [`src/core/auth/routes.ts`](./src/core/auth/routes.ts) `pendingRoutes`

<a id="e-26"></a>

**E-26 — WebAuthn is a sign-in path of its own, and synchronised passkeys are distinguishable from device-bound ones.**
*Context:* Passkey sign-in without a password and WebAuthn as a second factor (section 3.6).
*Rejected:* WebAuthn only as a second factor; discarding the flags.
*Reason:* The flags `backupEligible` and `backupState` arrive in the authenticator data anyway; not storing them would be a loss of information without a counter-value. They are stored and passed on — a policy on top of that is the application's business, not the library's. By the same logic a regressing `sign_count` is reported as the field `signCountRegressed`, not rejected: synchronised passkeys do not keep the counter reliably (L-9). And because WebAuthn is a sign-in path of its own, it counts among the paths whose last one may not be removed — the attempt fails with `last_sign_in_method` (L-13).
*Price:* Two columns and a pair of terms in the documentation that needs explaining.
*Where:* [`src/core/factor/webauthn/credential-repository.ts`](./src/core/factor/webauthn/credential-repository.ts) `backup_state`

<a id="e-27"></a>

**E-27 — Recovery codes: 160 bit, stored as HMAC, lookup instead of iteration.**
*Context:* Ten codes per user; in the configuration `username` the only way back into the account.
*Rejected:* Argon2id on every code.
*Reason:* At 160 bit of entropy from a CSPRNG a memory-hard derivation brings nothing — there is no dictionary. It would however force ten KDF calls per verification if the codes are iterated over. The HMAC allows the direct index hit. Every row carries `key_version`, so that a rotation of `token-pepper` does not devalue the codes (L-3).
*Price:* The rationale has to be in the documentation, otherwise it reads like negligence.
*Where:* [`src/core/factor/recovery/pepper.ts`](./src/core/factor/recovery/pepper.ts) `pepperRecoveryCode`

<a id="e-28"></a>

**E-28 — TOTP replay via `PRIMARY KEY (user_id, time_step)`.**
*Context:* Tolerance ±1 step (section 3.6); a code may be valid only once within the window.
*Rejected:* Reading and inserting as two statements.
*Reason:* The insert attempt **is** the check. That is race-free without a lock and without an additional query.
*Price:* A table that has to be cleaned up — via `auth.maintenance.sweep()` or the SQL delivered with it, not via a timer in the core (L-11).
*Where:* [`src/core/db/migrations/initial-schema.ts`](./src/core/db/migrations/initial-schema.ts) `totp_used_step`

### Third parties

<a id="e-29"></a>

**E-29 — `(provider, subject)` is the only linking key. The email is never one.**
*Context:* Provider linking (section 3.10) and import (section 4.0.6).
*Rejected:* Linking via email equality, even with a verified provider address.
*Reason:* This is the most frequent grave class of fault of all: CVE-2026-53516 (CVSS 8.3), GHSA-qq9h-g4jm-xgf3 (8.3), GHSA-fmh4-wcc4-5jm3 (7.7) — three times the same cause in one code base. Automatic linking happens only if the provider reports the address as verified **and** the local account is verified **and** the provider is configured as trusted. Three conditions, all three necessary. The same rule applies inwards: if an address is confirmed for the first time and the existing password comes from a different session than the one now confirming, the password sign-in is deleted and every session revoked (L-12) — otherwise an attacker's advance access stays valid, exactly the fault from GHSA-qq9h-g4jm-xgf3.
*Price:* More explicit linking in the user flow.
*Where:* [`src/core/oauth/linking.ts`](./src/core/oauth/linking.ts) `automaticLinkIsAllowed`

<a id="e-30"></a>

**E-30 — Fourteen providers instead of thirty-six.**
*Context:* Provider list at launch (section 3.10).
*Rejected:* Drawing level with Better Auth's provider list.
*Reason:* The interface is the value, not the number. Providers are the part that can be caught up on most cheaply later — and every single one is a maintenance load when its OAuth behaviour changes. Better Auth's provider abstraction is, by the way, the cleanest corner of its code base and serves as the model here.
*Price:* A shorter list on the product page.
*Where:* [`src/core/oauth/providers.ts`](./src/core/oauth/providers.ts) `DESCRIPTORS`

<a id="e-31"></a>

**E-31 — Foreign tokens are not stored by default.**
*Context:* Access, refresh and ID tokens of the providers after the sign-in.
*Rejected:* Storing as the default, encrypted.
*Reason:* What is not stored cannot leak. Most applications do not need a provider token after the sign-in; whoever needs it switches it on and gets it encrypted.
*Price:* An option that some overlook and then go looking for.
*Where:* [`src/core/oauth/config.ts`](./src/core/oauth/config.ts) `storeTokens`

### Extensibility

<a id="e-32"></a>

**E-32 — Enumerated extension points instead of open extensibility.**
*Context:* Plugin interface (section 3.11).
*Rejected:* Better Auth's model, in which a plugin can override core endpoints, mutate the context by `Object.assign`, replace `password.hash` and write the options of foreign plugins.
*Reason:* There this is not a theoretical possibility: the Stripe plugin actually writes into the options of the Organization plugin (`packages/stripe/src/index.ts:256`) and thereby produces an invisible order dependency. Collisions are only logged, `init` runs without `try/catch`, and `plugin.migrations` as well as `plugin.adapter` are dead code. A plugin is a listener with a right of veto, not a co-owner.
*Price:* Many a plugin that would be possible there is impossible here. That is intended.
*Where:* [`src/core/plugin/registry.ts`](./src/core/plugin/registry.ts) `HOOK_POINTS`

<a id="e-33"></a>

**E-33 — A name collision is a start error.**
*Context:* Two plugins, or a plugin and the core, claim the same route or table name.
*Rejected:* A warning in the log, as Better Auth does it.
*Reason:* A warning in the log is not read in operation. An error at start is read.
*Price:* Less leniency at the introduction.
*Where:* [`src/core/plugin/registry.ts`](./src/core/plugin/registry.ts) `assertNoCoreRouteIsOverwritten`

<a id="e-34"></a>

**E-34 — One route declaration produces handler, server method and client.**
*Context:* Client and server must know the same surface (section 3.12).
*Rejected:* Better Auth's runtime proxy over path segments with the heuristic "body present, so POST".
*Reason:* There is no runtime contract between client and server there; the types arise purely statically from `Auth["api"]`, which leads to the known inference problems (issues #1252, #4654 with TS2742, #5159). Derived from one declaration, a call that does not exist cannot compile.
*Price:* A declaration layer that has to be maintained.
*Where:* [`src/core/http/route.ts`](./src/core/http/route.ts) `defineRoute`

### Scope

<a id="e-35"></a>

**E-35 — No roles, no permissions, no organisations.**
*Context:* Specification of the client.
*Rejected:* Roles and organisations as an optional module in the same package.
*Reason:* The numbers support it: in Better Auth, 133 of 618 functions fall to authorisation and identity-provider roles (section 1 I and J); the documentation of the Organization plugin alone comprises 2586 lines. That is a product of its own that only happens to live in the same package. The library answers who is signed in — what that person may do is known only to the application.
*Price:* Whoever wants both needs two things. That is the right number.

<a id="e-36"></a>

**E-36 — 322 of 618 functions are left out.**
*Context:* Result of the function comparison (section 1).
*Rejected:* Function parity with Better Auth as a goal.
*Reason:* Not as an economy measure, but because 133 of them lie outside the purpose, 32 fall to session variants that contradict the revocation promise, and 28 to database abstraction that falls away with the commitment to PostgreSQL. 268 are adopted or solved differently, 28 exceeded.
*Price:* Velve Auth is not a replacement for every Better Auth deployment. Where it is one, it is a better one.

<a id="e-37"></a>

**E-37 — No email sending, no audit log, no admin interface.**
*Context:* Operational functions around the sign-in (section 3.14).
*Rejected:* Built-in sending, an audit table in the schema, a delivered interface.
*Reason:* Sending is a callback, because every serious application already has a sending path and the library should not get in the way there. Audit log and interface belong to the application, which knows the domain context. Better Auth likewise has neither in the open part — there, however, because they are paid products.
*Price:* More work at integration.

### Migration

<a id="e-38"></a>

**E-38 — Migration is a core function with a dry run, not a guide in the wiki.**
*Context:* Five sources as a specification of the client (section 4).
*Rejected:* Guides with an example script, as Better Auth delivers them.
*Reason:* Better Auth has five guides; the three that concern passwords all recommend the same thing — switch globally to bcrypt(10) — and for Firebase, the only source with a non-trivial hash, there is none at all. An import without a prior dry run is a blind flight: which procedures lie in the estate is not known beforehand.
*Price:* The most laborious individual building block after the core.

<a id="e-39"></a>

**E-39 — md4, md5, sha1 and raw HMAC are not verified.**
*Context:* Auth0's `custom_password_hash` and Clerk's `password_hasher` can contain such procedures (sections 4.2 d and 4.3 d).
*Rejected:* One-time verification with an immediate rehash.
*Reason:* That would create permanent legacy surface in the core for hashes that are effectively plaintext — and the one-time character could not be enforced. The rule is: no procedure that neither iterates nor is memory-hard; it also hits `sha256`, `sha512` and `ldap` at Auth0 as well as ten of the nineteen Clerk procedures. Those affected get the reset path (E-41).
*Price:* In an Auth0 migration with an old estate these users have to set their password anew.
*Where:* [`src/core/password/scheme.ts`](./src/core/password/scheme.ts) `LEGACY_SCHEMES`

<a id="e-40"></a>

**E-40 — No automatic merge on a collision.**
*Context:* Two source accounts with the same email (section 4.0.6).
*Rejected:* Merging; "oldest account wins" only on an explicit instruction (`skip-duplicates`).
*Reason:* When merging two source accounts with the same address, only one password hash survives — that is a privilege escalation through migration and breaks the same rule that E-29 sets up for OAuth.
*Price:* Collisions abort the run and have to be decided.

<a id="e-41"></a>

**E-41 — Unverifiable hashes lead to a reset obligation in a table of its own, not to a sentinel in the PHC field.**
*Context:* Reset path for users without a usable hash (section 4.0.5).
*Rejected:* A placeholder value in `password_credential.phc`.
*Reason:* A sentinel value would have forced a further prefix line in the switch and thereby extended the verification path by a special case that is not a hash. The response at sign-in stays byte-for-byte identical; the hint moves into the email.
*Price:* A table and an additional query in the error branch.
*Where:* [`src/core/db/migrations/initial-schema.ts`](./src/core/db/migrations/initial-schema.ts) `password_reset_required`

### Security by default

<a id="e-42"></a>

**E-42 — Every security-relevant setting is safe in its default value.**
*Context:* Better Auth's advisory history (section 5).
*Rejected:* Convenient defaults with security options to switch on.
*Reason:* The evaluation of the 33 advisories yields: the most frequent cause is not a crypto weakness but a missing owner check (10 cases), and almost every critical rating hung on a default setting. A weakening must be explicit, logged and visible at start.
*Price:* Less convenience at the introduction.
*Where:* [`src/core/auth/security-options.ts`](./src/core/auth/security-options.ts) `SECURITY_OPTIONS`

<a id="e-43"></a>

**E-43 — Every repository method on user-bound tables demands an `actor`.**
*Context:* Ten of 33 advisories of the class "missing owner binding".
*Rejected:* Owner checking in the handler, enforced by review.
*Reason:* The ten advisories of the class "missing owner binding" have the same shape: a missing line `AND user_id = :actor`. If the signature forces the caller to name the acting party, it cannot be forgotten — it can only be given wrongly, and that is a visible error instead of an invisible one.
*Price:* Somewhat more typing in the core.
*Where:* [`src/core/db/repositories/owned-row-repository.ts`](./src/core/db/repositories/owned-row-repository.ts) `createOwnedRowRepository`

<a id="e-44"></a>

**E-44 — Purpose-separated keys via HKDF, the version in the envelope of every produced value.**
*Context:* Six key purposes (section 3.8).
*Rejected:* One secret for everything, as Better Auth does it.
*Reason:* There `ctx.secret` signs cookies, email JWTs and the cache HMAC; rotation is implemented only for encryption, signatures do not rotate, and a change of secret devalues all sessions and all open links at the same time. Here every rotation survives all sessions, because sessions are opaque database rows and are connected to no key. Where no envelope exists, the version stands as a column: `password_credential.key_version` for `password-enc` (L-2) and `recovery_code.key_version` for `token-pepper` (L-3).
*Price:* A key ring that wants managing.
*Where:* [`src/core/keys/envelope.ts`](./src/core/keys/envelope.ts) `sealEnvelope`

<a id="e-45"></a>

**E-45 — The `__Host-` prefix for all cookies of the library.**
*Context:* `__Host-velve_session` and `__Host-velve_pending` (sections 3.5, 3.6).
*Rejected:* `__Secure-` with a configurable `Domain`.
*Reason:* The prefix makes the browser enforce `Secure` and `Path=/` and forbid `Domain` — cookie tossing from a taken-over subdomain is thereby ruled out. Better Auth defines the prefix (`cookies/cookie-utils.ts:35`) but never sets it — `cookies/index.ts:75` only chooses between `__Secure-` and no prefix.
*Price:* No `Domain` scope, so cross-subdomain needs a token exchange instead of a shared cookie.
*Where:* [`src/core/http/cookies.ts`](./src/core/http/cookies.ts) `DEFAULT_COOKIE_NAMES`

<a id="e-46"></a>

**E-46 — Enumeration protection is the default value and lies in one place.**
*Context:* Sign-in, registration, reset and email change (section 3.13).
*Rejected:* Protection per endpoint, retrofittable.
*Reason:* In Better Auth it was reported afterwards four times individually (#7972, #7944, #5017, #8096), does not take effect in the standard setup even in 1.7.3, and `/sign-up/email` logs the address in plaintext while returning 422. Retrofitted protection is patchy protection. Two consequences follow from that: "account disabled" is invisible at sign-in and appears only on the resolution of an existing session (L-4); and the account-related counter is formed on the identifier, not on the account ID, so that it takes effect before the user resolution and treats existing and non-existent accounts alike — exceeding it rejects instead of delaying, because a delay would be a timing channel (L-5). For the same reason there is no `requireEmailVerification`: a sign-in block for unconfirmed accounts would be an enumeration channel and at the same time a dead end, because `email.requestVerification` demands a session. Sign-in and registration always deliver a session, `User.emailVerifiedAt` carries the state, the application decides (section 1, A5; S-TIM-7).
*Price:* Error messages are less convenient for developers. The true reason is in the server log.
*Where:* [`src/core/identity/resolution.ts`](./src/core/identity/resolution.ts) `findUserByIdentifier`

---

## From the build

<a id="e-100"></a>

**E-100 — A raw NUL byte made a test file invisible to the attribution check.**
*Context:* A test case used `"velve\0"` as a hostile schema name, and my test connection compared the field terminator of an error message with the same byte. Git classifies a file containing NUL as binary; `git grep -I` skips it and `git log -p` shows `Bin`. The gate planted an attribution marker in the test file and ran the CI job verbatim: no hit.
*Rejected:* Extending the check with a `--text` and leaving the files as they were.
*Reason:* The gate did both, and that is right — but the file then still remains a diff nobody reads. The value of the byte is not the point in the test, only its effect; `String.fromCharCode(0)` produces the same name, and the byte comparison in the test connection was clearer written as a number anyway.
*Price:* The commit that fixes this still shows `Bin` for the test file, because one side of the comparison is the old binary blob. Only the next commit to this file is readable again. Retroactively there would only be rewriting history, and that is the more expensive price. Instead, the gate searched all 137 historical blobs as raw bytes: the entire content that was ever unreadable is one line — the literal `"velve\0"` itself —, and a marker stands nowhere.

*Two corrections to the first version of this entry. Both are measured, not concluded.*

*(a) The cause.* The first version wrote that the formatter had rewritten the escape sequence into a real NUL. **That is wrong.** It was a reconstruction that stood there as an observation: I took the obvious explanation instead of checking it, and with that closed the question. The gate measured it four times with the Biome version and the configuration of this repository — a file with `"velve "`, one with a space and one with an already present raw NUL come out unchanged from both `biome format --write` and `biome check --write --unsafe`; `tsdown` writes only to `dist/`, `vitest` only to `test/__snapshots__/`, and building, formatting, unsafe fixing and testing left every versioned file byte-identical. No tool of this chain can produce the byte. **The file was written that way.** The direction is the point: the guard protects against an author, not against an accident, and a rule has to say against which of the two.

*(b) The reach.* The title of the first version spoke of two invisible files. Only one was ever binary. The NUL in `test/db-postgres-connection.ts` stood at byte 13735 and so beyond the 8000-byte window in which Git checks for binary data; this file was readable throughout and was checked throughout. The commit that fixes both claims the same too broadly in its body — it is pushed and will not be rewritten, and this line is the correction to it.

*Where:* [`tools/check-reviewable-text.mjs`](./tools/check-reviewable-text.mjs) `trackedTextFiles()` · [`test/db-identifier-injection.test.ts`](./test/db-identifier-injection.test.ts) `String.fromCharCode(0)`

<a id="e-186"></a>

### Yield to the timer phase, not the microtask queue
`E-186` · password · scheduling, frozen

**Context.** The comment on the tick constant claimed that yielding every 10 ms keeps one derivation from blocking every other request. For the pure path that is true; for the default case with `hash-wasm` installed it is not. The accelerator computes in **one** synchronous WebAssembly call and settles its promise in a microtask — the chain of release the semaphore, admit the next waiter, derive again runs entirely inside the microtask drain and never reaches the timer phase. The gate measured it: 800 concurrent sign-ins against a wait limit of 5000 ms, **14,684 ms total, zero refusals**, and in that time **not one timer in the process fired** — no rate window, no HTTP timeout, no readiness probe. The same flood with `hash-wasm` mocked away: 1 verified, 19 `rate_limited`.
**Rejected.** (a) Documenting that S-DOS-4 does not hold with `hash-wasm`. (b) Splitting the accelerator into blocks, as `asyncTick` does on the pure path. (c) Using `scheduler.yield()` where it exists.
**Reason.** (a) would have given up a requirement in the default position — the dependency is optional, but it is installed the moment somebody lists it, and then the library behaves differently from what it promises. That is exactly what S-DEFAULT-7 forbids. (b) is not possible: the call is a single WASM function with no entry point in the middle. What works is yielding **between** derivations, and that suffices: the 20 ms block of a single call is shorter than the 10 ms × several rounds of the pure path, and the timers run in between. (c) fails on two counts that have nothing to do with which phase it reaches. In this runtime `globalThis.scheduler` does not exist at all; `scheduler.yield()` is reachable only from `node:timers/promises`, and section 2.6 has the core assume Web standards rather than Node builtins, so importing it is not open to this module. And `setTimeout` is the very primitive the wait limit itself uses — yield and deadline then sit in one queue and cannot outrun each other, which no other yield gives.
**Price.** One timer round per derivation, so about one millisecond in twenty — roughly five per cent of what the accelerator buys. And the library now yields differently in two places depending on the engine; whoever changes one has to remember the other. The test plan records it: the case runs against the engine the runtime actually chooses, and fails if that engine starves the timer phase.
**Addendum.** The reason first written down here for rejecting (c) was false, and it is left standing above the correction rather than quietly swapped: it said `scheduler.yield()` "returns to a continuation queue, and what has to run here is the timer phase". That is true of the browser Prioritized Task Scheduling API and false of Node, where the implementation is `setImmediate`-based and reaches the timer phase perfectly well. Measured on this repository's runtime — Node 26.8.1, 30 accelerated derivations against a 10 ms interval, three runs, identical every time: no yield → 0 timer firings, `setTimeout(…, 0)` → 29, `setImmediate` → 29, `scheduler.yield()` → 29, `queueMicrotask` → 0. The shipped decision is unchanged and the two reasons that do carry it are now in the entry. The lesson is the cheaper one: a rejection that names a mechanism is a claim about behaviour, and this one was never run.

**Where.** [`src/core/password/argon2.ts`](./src/core/password/argon2.ts) `yieldToTimerPhase()`

<a id="e-188"></a>

### `concurrentHashLimit` lowers the bound and never raises it
`E-188` · password · configuration, frozen

**Context.** The reference promised that every limit of this module points in the safe direction and that an attempt to weaken one is refused. For the semaphore that was untrue: `resolvePasswordConfig({ concurrentHashLimit: 100_000 })` was accepted and thereby asserted a memory bound of 1855 GiB — on exactly the S-DOS-3 argument the paragraph rests on. bcrypt came on top: the four cost limits of E-182 applied to "every stored credential", except bcrypt has no memory parameter and was not among them. An imported `$2a$31$` row occupies a semaphore place for hours.
**Rejected.** (a) Weakening the promise in the reference instead of binding the code. (b) Deriving the ceiling for `concurrentHashLimit` from the reported core count, so that a 64-core machine gets more.
**Reason.** (a) would have saved the statement and given up the requirement. S-DOS-3 names `min(4, cpus)` as **the** bound of the library, not as a starting value, and T-DOS-3 measures exactly that — an installation with a higher value does not meet the requirement, however large the machine. (b) would have moved the same problem into a formula. The option now lowers and never raises; whoever needs more concurrent derivations runs more processes. For bcrypt the cost number is the only available bolt, and 14 is four steps above what GoTrue, Auth0 and Clerk write.
**Price.** Two values a configuration used to accept are now startup errors, and an estate with bcrypt cost above 14 is no longer verifiable and goes down the reset path. The second price is more honestly named: both gaps stood in the reference as a promise before they stood in the code — the documentation ran ahead of the code, and that is the order in which a promise becomes false.

**Where.** [`src/core/password/limits.ts`](./src/core/password/limits.ts) `bcryptCostIsAcceptable()` · [`src/core/password/config.ts`](./src/core/password/config.ts) `CONCURRENT_HASH_LIMIT_CEILING`

<a id="e-223"></a>

### `::ffff:203.0.113.42` is truncated as IPv4
`E-223` · session · address family

**Context.** An upstream proxy frequently writes IPv4 addresses into `X-Forwarded-For` as IPv4-mapped IPv6 addresses. Read literally that is an IPv6 address and would be truncated to `/64`.
**Rejected.** Taking the family as the address is written.
**Reason.** `::ffff:0:0/96` is exactly one `/64`. Every IPv4 client behind such a proxy would land in the same prefix row — the metadata would be worthless, and the same confusion in rate limiting would be a shared bucket for half the internet. The mapping is a notation, not a family.
**Price.** The truncation now hangs on pattern recognition in the address space. Anyone who deliberately wants `::ffff:...` treated as an IPv6 address does not get that — and `2002::/16` (6to4) is the same case, but is not recognised, because it no longer occurs in practice.

**Where.** [`src/core/net/ip-address.ts`](./src/core/net/ip-address.ts) `unmappedIpv4Bytes()`

<a id="e-249"></a>

### Two branches wrote the same rule into the same gate file, and only a planted input told them apart
`E-249` · session · gate-tool ownership

**Context.** `test/db-static-sql.test.ts` holds the rule that a statement without an owner predicate has to declare itself. Both this branch and `main` rewrote that rule from a line comment to a block comment — independently, within the same wave, in the same file the working method says no two writers may share. Both arrived at the identical design and differed only in how the marker's body is matched: `main` wrote `[^*]*`, this branch wrote `[\s\S]*?`. On every statement in the repository the two agree, so the merge conflict looked like a formatting difference and nothing else.
**Rejected.** (a) Taking `main`'s form because `main` is the base and the base wins by default. (b) Keeping both expressions and accepting a marker either one accepts.
**Reason.** (a) is merge order deciding a rule, which is not a review; the reason it was rejected is that the difference had not been read yet, not that `main`'s form was known to be worse. Reading it settled it: `[^*]*` cannot cross an asterisk, so a marker whose reason contains one — `/* no owner predicate: S-TOKEN-4 (see the 5*3 rule) */` — is not recognised as a marker at all, and the statement is then reported as having no declaration whatsoever. That is the failure mode §5 of the repository rules names: the check can no longer tell "no marker" from "a marker it cannot parse", and the author is sent to fix something that is not wrong. (b) is worse than either single form, because a union of two patterns is a rule nobody can state in one sentence.
**Price.** The kept form is not the better one everywhere, and calling it a gain was wrong. `[\s\S]*?` stops at the first `*/` in the statement, so a marker that was opened and never closed is read as a complete declaration the moment any later comment supplies a closing marker — `/* no owner predicate: S-OWNER-2` followed further down by `/* anything */` counts as declared. PostgreSQL reads that same text as one comment running to the end, so the predicate the statement was exempted for is the predicate that got commented out. `main`'s `[^*]*` refused it, because it refuses every asterisk. Neither this check nor `check:sql-collapse` notices the result: the collapse check strips an unterminated comment the same way whichever order it works in, so the statement passes it too. The trade is therefore one blind spot for another, and the one taken on is the more dangerous of the two — it grants an exemption where the other only withheld one. It is left standing rather than patched a third time, because a third form of this expression needs its own argument and its own owner, and this branch has no claim to the file. The difference that decided the choice cannot be observed anywhere in the current tree — no marker in this repository contains an asterisk — so the resolution rests on a planted input and on nothing else, and it is only worth what that input is worth. The planted case is therefore now a test case in the same file, next to the two faults it must keep rejecting. The collision itself is not repaired by any of this: the file is still shared, nothing stopped either writer from opening it, and the next pair will meet in it the same way. Counting this branch alone, four crossings happened, not one — `test/decision-log.test.ts` for the English format, and `test/identity-sign-in-methods.test.ts`, `test/identity-last-method-race.test.ts` and their thirteen call sites once the narrowed `actorOfResolvedSession` met identity at the merge. All were reported rather than quietly taken; that is the whole of the safeguard, and it is a habit, not a mechanism. **Addendum:** one of the four was undone rather than kept. `test/decision-log.test.ts` is `main`'s again, taken whole when the central language pass landed; the version written here is gone, and nothing of it was merged back in.

**Where.** [`test/db-static-sql.test.ts`](./test/db-static-sql.test.ts) `DECLARES_NO_ACTOR`

<a id="e-657"></a>

### A plugin route name folds through `__proto__` and lands on it
`E-657` · plugin · the surface, finding

**Context.** 3.15 D.2 folds a route's dotted `name` into the object path of its server method, and `nestServerMethods` walks the segments, creating a namespace where it finds `undefined` and descending where it finds an object. A plugin route name is `${Id}.${string}`, which admits `audit.__proto__.x`. On that name the walk reads `node["__proto__"]`, gets `Object.prototype`, accepts it as a namespace because it is an object, and assigns the leaf into it. `createVelveAuth` does not throw, and `Object.prototype.x` is a function for the rest of the process.
**Rejected.** Reporting it as wave 4's rather than this feature's, on the ground that `surface.ts` is untouched by this branch.
**Reason.** Every core route name in this repository is written here and none of them contains `__proto__`; a plugin's is written by whoever wrote the plugin. The rule held over the core table and does not hold over the table that ships with plugins, which is the shape this review was told to hunt, and the code being inherited does not change where it is reachable from. `test/plugin-review-route-name.test.ts` holds the failing case and, beside it, the same name as a **last** segment, which is refused today because `"__proto__" in node` is true — so the gap is positional and the passing case proves the file's mechanism sees this family of names at all.
**Price.** Building the namespaces with `Object.create(null)` was planted and makes both cases pass, and it is offered as evidence that the test measures the defect and not as the repair: it also makes `audit.__proto__` a legal namespace name rather than a refused one, and whether that should be refused is the writer's decision and not the reviewer's.

**Where.** [`src/core/auth/surface.ts`](./src/core/auth/surface.ts) `nestServerMethods()`

<a id="e-930"></a>

### A registration that loses the insert race is answered as a taken address
`E-930` · email-flows · correction of E-627's reach, frozen

**Context.** Occupancy is read outside the transaction that inserts, and `discard` is decided from that read. Four connections registering one free address all read "free", one commits, and the other three meet the unique index on `velve.user.email`. The violation was unmapped, so the pipeline answered `500 internal_error` — measured `[500, 500, 200, 500]` over four racing connections, on both sign-up rows. Two things are wrong with that. `internal_error` is not among the codes either sign-up row declares, and 3.15 D.1 makes `errors` a contract; this branch already treated that clause as binding when E-615 changed the code rather than the declaration. And it is the loudest S-ENUM-3 difference there is — 200 against 500 — on the one path whose whole argument is that the two branches are byte-identical. A user who double-submits a registration form reaches it.

**Rejected.** Adding `internal_error`, or a new code, to the two declarations. It makes the contract true and the answer an oracle: the status alone would then say that the address was taken while the caller was registering. Also rejected: moving the occupancy read inside the transaction, which changes nothing — the read still precedes the insert and READ COMMITTED does not make the pair atomic — and serialising registrations on the address, which puts a lock in front of the one endpoint 3.13 wants uniform and which E-931 would then have to take out again.

**Reason.** A registration that loses the race is a registration for an address that is now taken, and that state already has an answer: the cover of E-627, byte-identical by construction. The unique violation is caught and the same `register` runs with `discard`. Which of the two unique indexes was hit is **asked for** rather than read out of the driver's error — the username first, then the address — because the constraint name travels in a field `pg`, `postgres.js` and the test connection do not agree on, and because a name taken in the same race must still answer `username_taken` (3.4).

**Price.** Three. A loser now runs the KDF once and two transactions, and nothing bounds how often that happens beyond the two rate limiters. `taken` used to carry two facts at once — whether the registration was discarded, and who owns the address — and the race is what separates them, so the announcement has a third case: the address was held at the insert and the account holding it was gone by the time it was looked for, and no message goes out because there is nobody to write to. That case needs a registration and a deletion to interleave inside one request, so it is not an enumeration channel, but it is a third observable where there were two. And a unique violation this code cannot attribute to either index is re-raised as it arrived: in mode `username_email`, a username taken during the **cover** insert is still a 500.

**Where.** [`src/core/flows/sign-up.ts`](./src/core/flows/sign-up.ts) `registerOrCover()`

<a id="e-1502"></a>

### The library does not work on PostgreSQL 14, and one line is why
`E-1502` · gate and infrastructure · a genuine incompatibility, measured and not repaired here

**Context.** The suite was run against a real PostgreSQL **14.24** before `ci.yml` was touched — a Homebrew `postgresql@14` cluster on port 54314 with `max_connections` at the container default of 100, reached over TCP through `VELVE_TEST_DATABASE_URL`. That the suite reached it was checked rather than assumed: a throwaway case opening `openTestConnection()` and printing `current_setting('server_version')` answered `14.24 (Homebrew)` / `140024`, because a green run against the machine's own 18.3 is exactly what this exercise would otherwise produce. `pnpm test` on 14: **228 failed, 2010 passed, 29 skipped over 216 files, exit 1**. The same tree on the local 18.3: **2254 passed, 13 skipped, exit 0**. `pnpm test:nightly` on 14: the same 228, no case beyond them. `pnpm test:release` on 14: 5 passed, exit 0.
**Rejected.** Repairing it on this branch. `src/core/db/repositories/session.ts` is the `session` feature's file and §5 binds a feature to the files it was given; the brief that opened this branch frames a genuine incompatibility as a finding with two owners' decisions behind it — raise the stated minimum, or fix the library — and neither is a CI branch's to take. `E-1446` is the standing precedent and it went the same way: four unblocked hand-offs, none of them built in the branch that found them. Also rejected: reporting 228 failures as 228 findings.
**Reason.** They are **one** root cause, and that was established by patching rather than by reading. `toInterval` at `src/core/db/repositories/session.ts:172` renders a deadline as `` `${Math.round(milliseconds)} milliseconds` `` and the statements bind it as `$3::interval`. PostgreSQL caps the `milliseconds` field of an interval literal at a signed 32-bit value **before 15**: measured on 14.24, `INTERVAL '2147483647 milliseconds'` is accepted and `INTERVAL '2147483648 milliseconds'` is `interval field value out of range`; both are accepted on 18.3. `DEFAULT_SESSION_CONFIG.absoluteTimeout` is `"30d"`, which is 2,592,000,000 ms, so **every session this library inserts fails on a default configuration**, and the sign-in, sign-up, OAuth and email flows answer 500 above it. 104 of the 228 name the interval in so many words; the rest are that 500 seen from a route. A scratch patch rendering the same value in seconds took the run to **1 failed, 2253 passed, 13 skipped** — the remaining one is `E-1503` and is not this. `idleTimeout` at `"7d"` is 604,800,000 ms and stays under the wall, so the defect reaches the absolute deadline first.
**Price.** The leg this branch adds is **red on `main` until that line is repaired**, and merging it before the repair blocks every branch — which is stated here rather than left for the merge to discover. Two repairs were measured against both servers and neither was applied: rendering seconds instead of milliseconds moves the wall from 24.8 days to about 68 years and does not remove it, since `Duration` can express `"99999d"` and 14 still refuses at 2,147,483,648 seconds where 18.3 accepts; `make_interval(secs => …)` answers identically on 14.24 and 18.3 at 2,147,483,648 and at 8,640,000,000 seconds and removes the wall, at the cost of changing two statements rather than one function. **The whole suite was run only against the first of those**, so the second is a measured SQL expression and not a measured tree, and saying otherwise would be the error `E-1390` catalogues.

**Where.** [`src/core/db/repositories/session.ts`](./src/core/db/repositories/session.ts) `secondsOf()`

<a id="e-1532"></a>

### Load hides a real leak, measured on planted code rather than on the statistic
`E-1532` · timing-power-guard · measurement, frozen

**Context.** `E-1149` simulated its claim with a 6 ns leak added to the file's own statistic and disclosed that the three figures were not its own. This branch planted **300 000 ns** — inside 5.1 (a)'s band and at the low end of it — as a real busy wait inside `checkPassword`, taken only when the credential row exists, and ran the case as it stood on `main`. Four runs, one-minute load average 130.62, 98.63, 50.96 and 48.14: `|Welch t|` 2.18, 3.11, 1.92 and 7.65 against a limit of 4.5, and Cliff's delta 0.100, 0.188, 0.159 and 0.212 against 0.147. **The Welch criterion passed a real 300 microsecond leak in three runs of four, and the case as a whole passed it once**, at the highest load of the four.
**Rejected.** Reading the three Welch passes as the whole result. Cliff's delta caught the leak in three of the four runs, so the case is not blind to a 300 microsecond plant — it is blind on its primary criterion, and its second criterion caught this one by a margin of 8 per cent on its best run and 1.8 per cent on another, which is not a margin anyone should rely on. Also rejected: presenting the load ordering as monotone. It is not: the run at load 98.63 gave a larger `|t|` than the run at 50.96.
**Reason.** A claim about an instrument is worth what the plant behind it is worth, and `E-1390` catalogues four negatives on one branch asserted from the wrong surface. The plant here is in the source path the case measures, not in the samples afterwards, so what it establishes is a property of the case and not of arithmetic.
**Price.** Four runs is not a distribution, and the load figures are a one-minute average of a machine shared with other work rather than a controlled variable. What this entry establishes is that the passing case exists and was produced twice over on ordinary load; it does not establish a pass rate, and the number of runs is too small to offer one.

**Where.** [`test/timing-fixtures.ts`](./test/timing-fixtures.ts) `welchT()` · [`test/timing-fixtures.ts`](./test/timing-fixtures.ts) `cliffsDelta()`

<a id="e-1601"></a>

### Two deadlock cycles, driven against two servers rather than read out of the source
`E-1601` · lock-order · defect, reproduced

**Context.** The brief named two cycles and gave the server's own `40P01` for each. Nothing in the tree tested for either, and `pnpm check:lock-order` passed both. The first thing done on this branch was to reproduce them rather than to trust the report.
**Rejected.** Repairing from the description. A cycle is a claim about two transactions interleaving on one server; a repair argued from source reading would have been argued against the wrong thing, and the mode restriction below was not visible until the server named the lock it was waiting for.
**Reason.** Both were reproduced twice, with two instruments, on **PostgreSQL 18.3** and on **PostgreSQL 14.24** — four `40P01` reports. Once through the library's own repositories over the hand-written wire client in `test/db-postgres-connection.ts`, and once through two `psql` sessions against schemas built by the library's own migrations, which is where the server's `CONTEXT` line is readable. **Cycle B**: `replaceEveryCode` holds the account row and waits for the account's recovery codes; a recovery-code redemption holds one of those codes and waits for the account row — and the second wait is the foreign key's, `CONTEXT: while locking tuple (0,7) in relation "user"` / `SQL statement "SELECT 1 FROM ONLY … FOR KEY SHARE OF x"`, taken by the `INSERT` of the new session and named nowhere in the library's SQL. **Cycle A**: a first address confirmation locks `password_credential` and then `session`; a password replacement locks `session` and then `password_credential`, `CONTEXT: while inserting index tuple (0,4) in relation "password_credential"` — and **no explicit row lock appears in either**. The two locks on the account row that could have ordered them, `FOR NO KEY UPDATE` from the confirmation's `UPDATE` and `FOR KEY SHARE` from the replacement's foreign key, do not conflict; that was measured too, and is E-1604.
**Price.** Both reproductions arrange their interleaving, so each shows that *an* interleaving deadlocks and neither says how likely it is. Nothing here counts the interleavings that do not deadlock, and no claim is made about cycles other than these two: what is repaired below is two cycles and one class, not the tree.

**Where.** [`src/core/db/lock.ts`](./src/core/db/lock.ts) `lockAccountRow()`

<a id="e-1691"></a>

### The WebAuthn second factor stood outside the budget its own route declares
`E-1691` · second-factor · L-8, closed

**Context.** `verifyUnderPendingAttemptLimit` is the one place L-8's five attempts are counted, and at `f1e9654` it had exactly two callers, `totp.verify` and `recovery.verify`. `/factor/webauthn/authenticate/finish` declares `too_many_factor_attempts` in `PENDING_ERRORS` and 3.15 D.3 declares it too, and nothing on that path could raise it. 3.6 puts the five on the intermediate state — *„Ein Zwischenzustand erlaubt höchstens fünf Versuche"* — not on a factor.
**Rejected.** Counting the failures inside `core/factor/webauthn`, which is what `E-471` refused and refused rightly: a factor that counts its own failures either double-counts or misses its neighbour's. Also rejected: counting a failed `authenticate.start`. D.3 gives that row the address bucket alone and lists `invalid_pending_authentication` and `factor_not_enrolled` and nothing else, where the finish row is given the account bucket and the 429; a challenge that judges nothing is not an attempt.
**Reason.** The wrap goes where the route is declared, which is the layer `E-471` handed it to, and it reuses the function the other two factors use rather than a second copy of the five. The file moved from `core/factor/totp` to `core/factor/pending` in the commit before, for the reason `E-471` gives — the count belongs to whoever owns the state. Every failure of `authenticate.finish` spends an attempt, including `webauthn_challenge_invalid`, because that is what TOTP already does with a replayed step and a second rule here would be a second answer to one question.
**Price.** A client that submits a consumed challenge twice now burns budget for it, and nothing distinguishes that from a guess. And the wrap resolves the pending state a second time — the pipeline already resolved it to fill `context.pending` — so the route costs one extra `SELECT` on the failing and the succeeding path alike. That was preferred to a second entry point that takes the resolution, because two ways of entering the one counter is how the count drifts.

**Where.** [`src/core/factor/routes.ts`](./src/core/factor/routes.ts) `webAuthnRoutes()` · [`src/core/factor/pending/attempt-limit.ts`](./src/core/factor/pending/attempt-limit.ts) `verifyUnderPendingAttemptLimit()`

<a id="e-1771"></a>

### The check reasoned about the tag that was asked for, and npm ignored it
`E-1771` · gate and infrastructure · blind spot, found by publishing

**Context.** `check:release-tag` refuses a prerelease published under `latest`, and it decides that from `DIST_TAG`. The workflow passes `next`, so it passed. `npm publish --provenance --access public --tag next` then exited zero, and the registry answered `{"next":"1.0.0-next.1","latest":"1.0.0-next.1"}`. **npm points `latest` at the first version a package ever publishes, whatever `--tag` says.** `check:published-version` read the registry afterwards and refused: *"1.0.0-next.1 is a prerelease and latest points at it, so a bare install of @velve/auth resolves to it."*
**Rejected.** (a) Removing the `latest` tag, which npm does not permit. (b) Publishing `1.0.0` stable immediately so that a stable version takes `latest`. (c) Making the new pre-publish clause a refusal rather than a report.
**Reason.** (a) is not available, so the state stands until a stable version takes `latest` from it. (b) would put `E-1741`'s start error into a stable line hours after it was written and end the prerelease cycle to fix a tag, which is the larger cost by far. (c) would make the **first** publish of any package impossible without an override, and the condition it reports cannot be avoided — only known about. So `check:release-tag` asks the registry whether the package is there, and where it is not and the version is a prerelease it says, before the publish, that `latest` is about to be taken as well.
**Price.** The tool now reaches the network, which it did not. Three states are distinguished and the third is the one that costs: a registry that **could not be asked** reports that the first-publish question is unknown and proceeds, because refusing there would refuse every release run without network — so a release cut behind a proxy gets no warning and no refusal, and the condition returns in silence. And a report is not a refusal: the sentence is printed in the same job that publishes a minute later, so **it is read after the fact unless someone is watching**. That is weaker than it looks and is stated rather than dressed up; a refusal with a named opt-in is the stronger shape and is left as a hand-off rather than taken, because it was not what this repair was asked for.

**Where.** [`tools/check-release-tag.mjs`](./tools/check-release-tag.mjs) `packageIsAlreadyOnTheRegistry()`

<a id="e-1900"></a>

### A mode that could link an account but never create one
`E-1900` · oauth-signup · the defect, measured before it was touched

**Context.** In `identity.mode: "username_email"` a person who does not yet exist cannot be created through a provider. Reported as four artefacts and each confirmed against `src/` rather than the `dist/` the report read: `createAccountFor` passes `{ email: account.email }` and nothing else (`oauth/service.ts:289`); `resolveUsernameColumns` answers `{identifier: "username", rejection: "required"}` at `identity/columns.ts:68–71`, **before** line 73 looks at `configuration.username`, so configuring a username policy cannot help; a rejection that is not the address becomes `oauth_flow_invalid` (`service.ts:293`); and `beforeUserCreate` sits at `service.ts:305`, after the throw, returning `Promise<void>` and unable to contribute anything. Reproduced as a case before a line was changed: **400, no account.** The counter-check the report gives passed on the first run — with `emailClaim` absent the refusal is the address's `oauth_provider_error`, with it configured the refusal moves to the username. That is what identifies the username as the blocker.
**Rejected.** Treating it as a configuration error, which is the first reading and the one line 68 rules out.
**Reason.** The failure is not that the operator configured nothing; it is that the mode requires an identifier no provider carries and no seam supplies. Linking works because linking has an account already.
**Price.** The case reproducing it asserts on a status and a row count, not on an error code, because a refused contribution and an absent one are the same `oauth_flow_invalid` from outside — which is the limit `E-1902` had to work around.

**Where.** [`src/core/oauth/service.ts`](./src/core/oauth/service.ts) `createAccountFor()`
