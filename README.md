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

Built. The authorisation-code flow with PKCE S256 — not optional, and with no
branch that downgrades it — a `state` that lives in the database while the
cookie holds only a pointer to it, a `nonce` under OIDC, the `iss` check of
RFC 9207, and the ID token verified against the provider's JWKS under a list of
asymmetric algorithms that does not contain `none`. Fourteen providers are built
in and any other is a set of endpoints and a subject claim in your
configuration; no discovery document is ever fetched, so an endpoint the library
calls is one you wrote down.

`auth.signIn.oauth.start` hands you an authorisation URL and the cookie
instruction that belongs to it; the callback answers 302 to a path you chose,
and that redirect is the only `Location` this library emits. In an existing
session, `auth.identity.link.start` links a second provider to the account you
are signed in as — the account and the session are both fixed server-side, so no
callback can point either somewhere else — and `auth.identity.unlink` refuses to
remove your last way in. Linking re-issues the session it was started from, a new
token in place of the old row, and leaves your other devices signed in; a link
whose own session was revoked or signed out while it was outstanding is refused
rather than handing back a fresh one.

**The linking rule is the part that does not bend.** `(provider, subject)` is
the only key; the e-mail address is an attribute and never a link. An identity
is joined to an existing account automatically only when the provider reports
the address verified **and** the local account is verified **and** the provider
stands in `trustedProviders` — three conditions, no switch that removes one. The
library invents no address for a provider that reports none, and creates no
account it cannot name.

### Email flows

Built. Eleven routes: sign-up with and without a password, the magic link and
its redemption, the confirmation link, the address change and both redemptions,
the mailed password reset and its redemption, and the reset that spends a
recovery code instead of an address.

The library sends nothing itself. It calls `email.send` with one of six message
kinds and the token, and the application builds the URL and delivers it — so no
`redirectTo` from a request has to be validated against an allowlist, because
none exists. A `send` that throws takes the artefact with it, and on sign-up the
account too; it runs after the transaction has committed, so a slow callback
never holds a lock on the account it is about.

Two answers are deliberately uninformative. A registration on an address that
already has an account answers byte for byte as a free one does, because it runs
the same registration and rolls it back; the difference is that a message goes to
the existing address instead. A registration that loses a race to the same
address is that answer too, so simultaneous submissions of one form come back
alike. Telling a taken address from a free one takes a second request —
resolving the session the answer hands back — and no further. In
`username_email` there is a second identifier and the cover does not durably
claim it: a registration on a taken address leaves the name it sent free, where
one on a free address takes it, so a second registration of that name tells the
two apart. A reset or magic
link for an address that names no account runs the same statements as one that
does, calls `send` the same single time, and waits the same, because the two
serialise on the address and neither takes a lock on the account's row. And when
an address is confirmed for the first time, a password that was set in a
different session is deleted and every session revoked — the account-takeover
path of GHSA-qq9h-g4jm-xgf3, closed by construction rather than by a flag.

### Plugins

A plugin declared in `plugins` is registered at start: its routes join the route
table under `/x/<plugin-id>/…` and become methods on the instance, its
`dependsOn` is sorted topologically, its migrations run, its error codes answer
and its rate-limit rules apply. A hook can refuse by throwing and observe by
returning; it cannot replace the answer, because every one of them returns
`Promise<void>`.

**A hook point only fires if an operation reaches it, and most of the operations
are not built yet.** `beforeSessionRevoke` runs today, on sign-out, on all three
revocation routes and on a revocation a plugin performs itself, before the rows
go, so a hook that throws leaves the session standing. Which of the seven have a producer is a table in
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
and on the direct server call alike; a plugin route cannot make itself a reader
of the cookie that carries a half-finished sign-in, and it cannot declare itself
exempt from the origin check. Twelve ways of configuring plugins wrongly refuse
the start rather than warning, among them a duplicate id, two ids where one is
the other's table prefix, a dependency on a plugin that is not configured, a
cycle, a route that collides with a core one, a route reaching for one of those
cookies or skipping the origin check, an error code outside the plugin's own
namespace, a route name folding onto something every object already has, and a
field the interface does not enumerate — which is how a plugin trying to put a
middleware in front of the origin check is answered.

A plugin's migrations run in the same versioned runner the core's do, recorded
under the plugin's own id so its version numbers are its own. What such a
migration did is measured while it runs, not read out of its SQL: what it created
or altered is read out of the catalogue rows its own transaction wrote, and what
it wrote and read out of the transaction's own counters. It may add exactly the
tables it declares, each carrying its prefix, and inside its own tables it may do
as it likes; it may create only tables and the objects a table brings with it, so
a view, a function or a trigger is refused whatever it is called, and so is
anything else it creates that belongs to none of its own tables; and it may not
create, alter, empty or remove anything it does not own, in any schema, nor write
a row into one, nor read one — **its own tables and no others, with no exception
for the ones it points at.** Declaring a foreign key to `velve.user` costs no
read and is the ordinary plugin table; filling such a table with rows naming real
accounts is refused, because the constraint check that costs is indistinguishable
from a copy of the table, and those rows are written after `migrate()` returns.
**Nothing that was in the schema before it ran may be gone or renamed
afterwards** unless it belongs to a table the plugin declared — which is how a
core index, a core constraint and a core trigger are covered without any list of
names to fall behind, since everything present before a plugin migration runs is
the core by construction. And **a plugin migration does not run on a superuser
connection**, nor on one whose role may create roles or holds `SET` on
`track_counts`, nor on one that can `SET ROLE` to any of them: every measurement
above is a privilege away from being switched off, so the connection is part of
the boundary. Run migrations as a role that **owns** the schema and holds none of
the three — the reference gives the four statements that produce one, says why
owning it rather than being granted it is what makes the advice work, and names
what a check reading three catalogue answers cannot rule out. Core migrations are unaffected, and
the refusal happens after the core schema has applied and before any plugin
migration has run, so nothing is left half-done. The refusal rolls the whole migration
back. What the measurements still do not see — a table dropped in the same
transaction, a comment, an empty schema left behind, a lock — is written down in
the reference rather than glossed here. There is no rollback of an applied
migration, and removing a plugin leaves its tables where they are.

### The client

Built. `@velve/auth/client` is the browser half, derived from the same route
declaration the server methods are. It is an ordinary nested object, not a proxy:
`createVelveClient` walks the route table once and puts a function at each leaf
that reads the method and the path from its own row. A call the table does not
carry is a compile error, and in JavaScript a `TypeError` — never a request to a
path that answers 404.

```ts
import { createVelveClient } from "@velve/auth/client";

const client = createVelveClient({ baseURL: "/api/auth" });

const answer = await client.signIn.magicLink.request({ email });
if (!answer.ok) {
  switch (answer.error.code) {
    case "invalid_input": return show("That address does not look right.");
    case "rate_limited":  return show(`Try again in ${answer.error.retryAfterSeconds}s.`);
    case "origin_not_allowed": return show("This page is not allowed to sign you in.");
  }
}
```

A call returns a result rather than throwing, and the asymmetry with the server
is on purpose: on the server a call sits in a request handler with a central
error map, in the browser every call site is a screen that has to render the
failure itself, and a forgotten `catch` is a screen that says nothing. The
compiler makes `ok` checkable before `value` is readable, and `error.code` is
narrowed to the codes **that** route declares, so the `switch` above is checked
exhaustively. `unwrap(…)` is there for whoever wants the throw back.

It throws in exactly two cases, both `VelveTransportError`: the server did not
answer, and the server answered with something that is not a Velve response.
"The server said no" is never one of them.

What reaches a browser is five modules, and one of them is the library's error
table so that `instanceof VelveError` holds on both sides. No driver, no handler,
no SQL, no dependency and no Node built-in — measured by walking the built output
rather than asserted.

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
