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
- **A passkey is a sign-in, and it is also a real second factor.** Discoverable
  sign-in gives a session with no password in it at all; the same credential
  after a password gives one with both. User verification is required at both,
  and there is no option that lowers it — which is the difference between a
  second factor and a button. The two authenticator flags that tell a hardware
  key from a synchronised passkey are stored in their own columns and rewritten
  on every sign-in, so an application can build a policy on them. The library
  builds none.

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

**The instance**, from `@velve/auth`. `createVelveAuth` reads the configuration,
refuses to start on one that cannot be made safe — a root key shorter than 32
bytes, an empty origin list, a username-only mode without recovery codes, Argon2
parameters below the floor — and returns the route table, the server methods and
the maintenance sweep. Sessions, sign-out and the state between password and
second factor work end to end today. [`DOCUMENTATION.md`](./DOCUMENTATION.md) states,
chapter by chapter, what each of the other areas has built; **this paragraph
names none of them**, because a sentence about everybody's progress is a
sentence everybody has to edit, and this one was wrong within a wave of being
written.

```ts
import { createVelveAuth, rootKeyProvider } from "@velve/auth";

const auth = createVelveAuth({
  database: driver,
  identity: { mode: "email" },
  keys: rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: process.env.VELVE_ROOT_KEY! } }),
  origins: ["https://app.example.com"],
  email: { send: async (message) => { /* … */ } },
});

await auth.migrate();
```

Every security-relevant setting defaults to the safe value, and an installation
that weakens one gets a line in its log at start naming the option. There is no
option that switches off the origin check, the rate limiter, PKCE or the state
check, and none that keeps other sessions alive across a password change.

[`DOCUMENTATION.md`](./DOCUMENTATION.md) has the schema table by table and every
option of both functions.

### Third-party sign-in

Not built yet. The configuration is declared — `oauth.providers` takes the
fourteen providers of architecture 3.10 by name and any other id with its own
endpoints, beside `trustedProviders` and `storeTokens` — and no route reads it.

### Email flows

Not built yet. The confirmation link, the address change, the password reset and
the magic link are one-time artefacts over a store that exists; the flows over
them do not.

### Plugins

Half built. A plugin declared in `plugins` is registered at start: its routes
join the route table under `/x/<plugin-id>/…` and become methods on the
instance, and its `dependsOn` is sorted topologically. A hook can refuse by
throwing and observe by returning; it cannot replace the answer, because every
one of them returns `Promise<void>`.

**A hook point only fires if an operation reaches it, and most of the operations
are not built yet.** `beforeSessionRevoke` runs today, on sign-out and on all
three revocation routes, before the rows go, so a hook that throws leaves the
session standing. Which of the seven have a producer is a table in
[`DOCUMENTATION.md`](./DOCUMENTATION.md) and is stated there and not here: a
plugin can register a point nothing reaches, and it will not run.

The context a hook is given is frozen and carries no writing method on the user,
the password, the TOTP secret or the recovery codes. A plugin's own SQL is
checked before it reaches the driver: a statement naming any core table, in any
position the checker reads as code, is refused, and so is one it cannot read at
all. It is a guardrail against the accident, not a sandbox — a plugin runs in
your process and can reach your driver by other means, and a core table named
inside a string literal the database later executes is not seen. The reference
says exactly what it refuses, what it lets through and where that hole is.

Origin checking and rate limiting run before any plugin code, on the HTTP path
and on the direct server call alike, and a plugin route cannot make itself a
reader of the cookie that carries a half-finished sign-in. Six ways of
configuring plugins wrongly refuse the start rather than warning: a duplicate id,
a dependency on a plugin that is not configured, a cycle, a route that collides
with a core one, a route reaching for one of those cookies, and a field the
interface does not enumerate — which is how a plugin trying to put a middleware
in front of the origin check is answered.

What is not built is the rest: plugin migrations do not run, and declared error
codes and rate-limit rules are not read. Each of those three writes a line to
your log at start naming the plugin and the field, so a declaration that does
nothing says so.

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
front of it. The three cookies the library can set — the session, the
intermediate state and the OAuth state pointer — carry the `__Host-` prefix and
cannot be reconfigured, and every response carries `Cache-Control: no-store` and
`Vary: Cookie` because a CDN in front is the normal case.

`basePath` is where you mounted the handler, and the address the connection came
from, if you want per-address rate limiting, comes from a function you pass in.
Neither is read from a request header, unless you configure `trustedProxies`:
`X-Forwarded-For` counts only where you have named who is allowed to write it,
because a header the caller controls must never decide which bucket it is
counted in.

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
  after it.
- [`VELVE-AUTH-ARCHITEKTUR.md`](./VELVE-AUTH-ARCHITEKTUR.md) — the binding
  specification the implementation is measured against. In German.
- [`VELVE-AUTH-ARCHITECTURE.md`](./VELVE-AUTH-ARCHITECTURE.md) — an English
  translation of it. Faithful, and not binding: where the two differ, the German
  is right and the translation has a bug.

## Using it with an AI coding agent

There is a skill that turns a coding agent into someone who actually knows this
library — one that reads the specification before answering, cites the clause its
answer rests on, refuses what the library deliberately does not do instead of
approximating it, and asks you rather than guessing.

It carries no copy of the documentation. Every answer comes from the files in this
repository, fetched live, because a stale copy of an authentication library's
interface is worse than none: it is confidently wrong.

That is also why it needs updating so rarely. It states method and no fact about the
library, so a release that adds a feature or moves a section leaves it current and you
have nothing to do. Its version is the `Skill version` line at the top of
[`CLAUDE-SKILL.md`](./CLAUDE-SKILL.md) — one number, in one place, and not repeated
here — and it moves only when the instructions themselves change. The skill checks it
against yours once per session, tells you in one line which version is running, and
asks before writing anything into your files. That check costs one fetch at the start
of each session that touches Velve Auth.

### Claude Code

Two commands, and it is available in every project:

```bash
mkdir -p ~/.claude/skills/velve-auth
curl -fsSL https://raw.githubusercontent.com/velve-dev/velve-auth/main/CLAUDE-SKILL.md \
  -o ~/.claude/skills/velve-auth/SKILL.md
```

That is the whole installation. Claude Code picks the skill up on the next start
and uses it whenever the conversation is about Velve Auth; you can also invoke it
by name with `/velve-auth`.

To commit it to one project instead, so everyone working on that repository gets
it, put it in the project rather than your home directory:

```bash
mkdir -p .claude/skills/velve-auth
curl -fsSL https://raw.githubusercontent.com/velve-dev/velve-auth/main/CLAUDE-SKILL.md \
  -o .claude/skills/velve-auth/SKILL.md
```

**Updating it is the same command.** `curl … -o …` overwrites, so whichever of the two
you ran is also how you install a newer version; there is no second procedure, and the
new version takes effect on the next invocation. Claude Code watches the skill
directories, so there is nothing to restart.

The one time you do need to restart is the **first** install, and only if the command
above had to create `~/.claude/skills/` (or the project's `.claude/skills/`) for you: a
directory that did not exist when the session started is not being watched yet. Restart
once, and it is watched from then on.

### Codex, and other agents that take one instruction file

[`CODEX-SKILL.md`](./CODEX-SKILL.md) is the same expertise as a single
self-contained file. Save it as `AGENTS.md` in the project root:

```bash
curl -fsSL https://raw.githubusercontent.com/velve-dev/velve-auth/main/CODEX-SKILL.md \
  -o AGENTS.md
```

Or paste it at the start of a conversation. It works either way, and it tells the
agent what to do if it cannot reach the network — ask you for the files, rather
than answer from memory.

The same command updates it, for the same reason. There is nothing to restart: the
file is read when you hand it over.

### What it will not do for you

It will tell you no. If you ask it for something this library deliberately does not do
— the list above is the one it reads — it will say so, give you the reason, tell you
where that belongs instead, and stop, rather than building you half of one inside your
authentication layer. It reads that list from this README every time rather than
carrying its own copy, so it cannot refuse you something the library has since grown.

## Licence

Apache License 2.0 © Velve — see [`LICENSE`](./LICENSE) and
[`NOTICE`](./NOTICE).

**Why Apache 2.0 and not MIT.** Apache 2.0 is exactly as permissive as MIT: it
is not copyleft, you may use this in a closed product, modify it, sell it, and
keep your changes to yourself. Nothing is withheld from you that MIT would have
given.

It does ask two things of you that MIT does not, and only when you
**redistribute**: section 4(b) wants modified files marked as modified, and
section 4(d) wants this project's `NOTICE` attributions carried into what you
ship. Neither touches you if you merely use the library.

It adds two things MIT is silent about, and both protect the people who depend
on this library rather than the people who wrote it.

**An express patent grant.** MIT says nothing about patents. Under it, someone
could contribute code and later assert a patent covering their own
contribution — against this project and against everyone using it. Apache 2.0
has every contributor grant a patent licence for what they contributed, and
that licence terminates for anyone who brings a patent suit over it. For a
library that sits on the authentication path of other people's products, that
is not a theoretical comfort.

**A trademark reservation.** MIT is silent on names, so a fork can argue the
licence let it keep calling itself Velve Auth. Apache 2.0 section 6 keeps names
and marks out of the grant explicitly. It does not prohibit anything —
trademark law does that, under either licence — but it removes the argument
that the licence conveyed the name.

The cost is honest and small: the file is 11,358 bytes where MIT's was 1,062,
and "MIT" is the string a developer recognises without reading. We took the trade
because the two gaps are the two that matter to a company shipping a security
dependency, and because relicensing is cheap now and effectively impossible
once other people have contributed.
