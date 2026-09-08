![Velve Auth](https://raw.githubusercontent.com/velve-dev/velve-auth/main/assets/banner.png)

# @velve/auth

**The European authentication library for TypeScript and PostgreSQL.**

It answers exactly one question — **who is signed in** — and it answers it
completely. The library runs inside your application's process and your users
live in your database, so no third-party authentication service ever sits
between you and them.

The only traffic that leaves your infrastructure goes to the OAuth providers you
choose to enable, and if you enable none, none does.

> **Status: in development.** The public interface is specified and frozen; the
> implementation is being built feature by feature. Nothing here is published to
> npm yet, and the version is `0.0.0` deliberately.

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

## Requirements

- Node 20.19 or newer
- PostgreSQL 14 or newer
- A PostgreSQL driver, which you supply

The library assumes Web standards only — `globalThis.crypto` with `subtle` and
`getRandomValues`, and `fetch`. There is no WASM on the required path, no native
binding, no install script, and no build step on your machine.

## Installation

```sh
pnpm add @velve/auth
```

## What works today

The schema and the database layer are built. The rest of the surface is being
added feature by feature.

**The schema.** Sixteen tables in their own PostgreSQL schema, `velve` by
default. The SQL is shipped as files under `migrations/`, so it can be read,
reviewed and applied with your own tooling; the library carries the same text
and never reads a file at run time.

**The migration runner**, from `@velve/auth/schema`. Versioned, forward-only,
one transaction per migration, guarded by a PostgreSQL advisory lock so two
processes starting at once cannot both migrate. It records each migration with
the checksum of its SQL and refuses to run if an applied migration has since
been edited. It also refuses any migration — a plugin's as much as its own —
that adds a table referencing `velve.user` without `ON DELETE CASCADE`.

```ts
import { Pool } from "pg";
import { createNodePostgresDriver } from "@velve/auth/pg";
import { assertSchemaUpToDate, coreMigrations, runMigrations } from "@velve/auth/schema";

const driver = createNodePostgresDriver(new Pool({ connectionString }));

await runMigrations({ driver, migrations: coreMigrations("email") });
await assertSchemaUpToDate({ driver, migrations: coreMigrations("email") });
```

**The driver**, from `@velve/auth/pg`. You create, own and close the pool; the
library never opens a connection and never reads a connection string. `pg` is
not a dependency of this package — the parameter is typed structurally.

`assertSchemaUpToDate` is the version contract: a database behind the package is
a startup error, not a warning.

[`DOCUMENTATION.md`](./DOCUMENTATION.md) has the schema table by table and every
option of both functions.

## Mounting it

The HTTP layer is one function. It takes Web `Request` objects and returns Web
`Response` objects, so it runs unchanged behind Node, Bun, Deno and any worker
runtime.

```ts
import { toWebHandler } from "@velve/auth/http";

const handler = toWebHandler(auth, { basePath: "/api/auth" });

export const GET = handler;
export const POST = handler;
```

Every route is declared once — path, method, input schema, output type, error
codes — and the request handler, the directly callable server method and the
typed client are derived from that one declaration. Each route declares which
checks stand in front of it, and every core route except the OAuth callback,
which by protocol has no `Origin` header, declares the origin check. Where a
check is declared it runs first, on both call paths, and no plugin can get in
front of it. The session and pending cookies carry the `__Host-` prefix and
cannot be reconfigured, and every response carries `Cache-Control: no-store` and
`Vary: Cookie` because a CDN in front is the normal case.

`basePath` is where you mounted the handler, and the client address, if you want
per-address rate limiting, comes from a function you pass in. Neither is read
from a request header: a header the caller controls must never decide which
bucket it is counted in.

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

## Documentation

- [`DOCUMENTATION.md`](./DOCUMENTATION.md) — the reference: every function,
  parameter, configuration option and table.
- [`CASE-STUDY.md`](./CASE-STUDY.md) — why it is built this way. Every design
  decision, every rejected alternative, written during the build rather than
  after it. In German.
- [`VELVE-AUTH-ARCHITEKTUR.md`](./VELVE-AUTH-ARCHITEKTUR.md) — the binding
  specification the implementation is measured against. In German.

## Licence

MIT © Levo Studio
