![Velve Auth](https://raw.githubusercontent.com/velve-dev/velve-auth/main/assets/banner.png)

# @velve/auth

[![npm](https://img.shields.io/npm/v/@velve/auth?label=npm&color=0b7285)](https://www.npmjs.com/package/@velve/auth)
[![licence](https://img.shields.io/npm/l/@velve/auth?color=0b7285)](./LICENSE)

**The European authentication library for TypeScript and PostgreSQL.**

It answers exactly one question — **who is signed in** — and it answers it
completely. The library runs inside your application's process and your users
live in your database, so no third-party authentication service ever sits
between you and them.

The only traffic that leaves your infrastructure goes to the OAuth providers you
choose to enable, and if you enable none, none does.

## Why it exists

Most authentication libraries answer a second question alongside the first —
what you are allowed to do — and a third — which organisation you belong to.
Those answers belong to the application, because only the application knows what
its permissions mean. A library that guesses at them grows features nobody can
remove.

This one refuses the second and third question. What is left is small enough to
be read end to end, and the parts that matter are the parts that are usually
wrong:

- **Passwords have a real upgrade path.** Verifying a hash and creating a hash
  are separate decisions. The library verifies Argon2, bcrypt, scrypt, PBKDF2 and
  Firebase's scrypt variant, and it always creates Argon2id. Imported hashes are
  silently rehashed on the next successful sign-in, so migrating away from a
  previous provider does not permanently downgrade every future user.
- **Email is optional.** A user can be identified by email, by username, or by
  both. No placeholder address is ever invented for a provider that does not
  return one.
- **Nothing confidential is stored in the clear.** What the server only compares
  is hashed. What it needs back is encrypted. Password hashes are additionally
  wrapped in an envelope key, so a stolen database dump on its own is not enough.
- **Enumeration resistance is the default**, not a configuration option, and it
  lives in one place rather than at each endpoint.
- **A passkey is a sign-in, and it is also a real second factor.** Discoverable
  sign-in gives a session with no password in it at all; the same credential
  after a password gives one with both. User verification is required at both,
  and there is no option that lowers it — which is the difference between a
  second factor and a button. The two authenticator flags that tell a hardware
  key from a synchronised passkey are stored in their own columns and rewritten
  on every sign-in, so an application can build a policy on them. The library
  builds none.

What the library deliberately does not do has a section of its own
further down.

## Requirements

- Node 20.19 or newer
- PostgreSQL 14 or newer. CI runs the whole test suite against 14 and against 16
  on every push, so the oldest version this list promises is exercised rather
  than inferred.
- A PostgreSQL driver, which you supply

The library assumes Web standards only — `globalThis.crypto` with `subtle` and
`getRandomValues`, and `fetch`. There is no WASM on the required path, no native
binding, no install script, and no build step on your machine.

## Installation

```sh
pnpm add @velve/auth
```

That is the whole install: no tag to remember, no `postinstall`, no native
binding, no build step. `latest` points at `1.2.0` and `^1.0.0` resolves to it.

## Example

A driver over your own pool, the instance, the migrations, and the handler
mounted at `/api/auth`:

```ts
import { Pool } from "pg";
import { createVelveAuth, rootKeyProvider } from "@velve/auth";
import { toWebHandler } from "@velve/auth/http";
import { createNodePostgresDriver } from "@velve/auth/pg";

const driver = createNodePostgresDriver(new Pool({ connectionString: process.env.DATABASE_URL }));

const auth = createVelveAuth({
  database: driver,
  identity: { mode: "email" },
  keys: rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: process.env.VELVE_ROOT_KEY! } }),
  origins: ["https://app.example.com"],
  email: { send: async (message) => { /* … */ } },
});

await auth.migrate();

const handler = toWebHandler(auth, { basePath: "/api/auth" });

export const GET = handler;
export const POST = handler;
```

Every route, option and table behind those four calls is in
[`DOCUMENTATION.md`](./DOCUMENTATION.md).

## What it deliberately does not do

This list is a promise, not a backlog. None of it is planned.

- Roles, permissions, policies, access control of any kind
- Organisations, teams, tenants, invitations, membership
- Profile data on the user record. A linked OAuth identity caches the claims
  the provider returned, because the application usually needs them; the user
  record itself holds nothing beyond what identifies the account.
- Acting as an identity provider — no OIDC provider, no SAML, no SCIM
- Databases other than PostgreSQL; no MySQL, no SQLite, no ORM adapter
- Billing, subscriptions, or anything that bills
- A hosted service, a dashboard, or a control plane
- CORS headers and preflight answers — that policy belongs in your reverse proxy
  or your application, in front of the library

If you need roles and organisations, you need a different library, and saying so
plainly is more useful than a plugin that half-implements them.

## Reading the code

A comment in `src/` is one sentence saying what must hold, sometimes ending in one identifier.
`(S-FIX-6)` is a security requirement, stated as a list item in section 5 of
[`VELVE-AUTH-ARCHITECTURE.md`](./VELVE-AUTH-ARCHITECTURE.md).
`(E-233)` is a design decision, an entry in [`docs/decisions/log.md`](./docs/decisions/log.md#e-233) with its context,
what was rejected, the reason and the price. `pnpm check:decision-refs` fails if one points nowhere.

## Status

> **Status: 1.2.0.** `latest` points at it, so `pnpm add @velve/auth` installs the
> stable line and `^1.0.0` resolves. Under semver the documented surface is a promise:
> nothing in it changes shape without a major version. `1.1.0` added an option
> and moved nothing. `1.2.0` is a security release and does not keep that promise
> in full: it adds five `VelveStartupError` codes, any of which can refuse an
> existing installation at start; a `RevokeReason` member, `email_verified`, that
> an exhaustive `switch` has to handle; a required `sessionCookieName` in
> `HttpEnvironment`; and changed rate-limit defaults. It is a minor version by the
> owner's decision rather than a major one (E-2214, E-2520). `next` keeps
> pointing at the last prerelease, `1.0.0-next.2`, and nothing needs it.

**What the `1.x` line commits this package to** is the surface
`DOCUMENTATION.md` describes: it may gain something in a minor version, and
nothing in it changes shape without a major one. What it does not claim is a
track record — the interface is specified and the schema is versioned, but this
library is newly published and has not yet been run in anger by anyone outside
this repository. Read `CASE-STUDY.md`, which ships inside
the package, for why the decisions that shaped it were taken, and
[`docs/decisions/log.md`](./docs/decisions/log.md) for every one of them.

## Documentation

- [`DOCUMENTATION.md`](./DOCUMENTATION.md) — the reference: every function,
  parameter, configuration option and table.
- [`CASE-STUDY.md`](./CASE-STUDY.md) — why it is built this way, in a selection:
  the decisions the specification started from, and the build entries that carry a
  measurement, a found fault or a discarded assumption.
- [`docs/decisions/log.md`](./docs/decisions/log.md) — the complete log. Every design
  decision, every rejected alternative, written during the build rather than
  after it.
- [`VELVE-AUTH-ARCHITEKTUR.md`](./VELVE-AUTH-ARCHITEKTUR.md) — the binding
  specification the implementation is measured against. In German.
- [`VELVE-AUTH-ARCHITECTURE.md`](./VELVE-AUTH-ARCHITECTURE.md) — an English
  translation of it. Faithful, and not binding: where the two differ, the German
  is right and the translation has a bug.

The agent skill and how to install it are in
[`DOCUMENTATION.md`](./DOCUMENTATION.md#using-it-with-an-ai-coding-agent).

## Licence

Apache License 2.0 © Velve — see [`LICENSE`](./LICENSE) and
[`NOTICE`](./NOTICE). Why Apache 2.0 and not MIT is in
[`DOCUMENTATION.md`](./DOCUMENTATION.md#licence).
