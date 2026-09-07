# @velve/auth

Authentication for TypeScript and PostgreSQL that answers exactly one question:
**who is signed in.**

It runs inside your application's process. Your users live in your database. No
third-party service is involved at any point.

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

## What it deliberately does not do

This list is a promise, not a backlog. None of it is planned.

- Roles, permissions, policies, access control of any kind
- Organisations, teams, tenants, invitations, membership
- Profile data beyond what identifies an account
- Acting as an identity provider — no OIDC provider, no SAML, no SCIM
- Databases other than PostgreSQL; no MySQL, no SQLite, no ORM adapter
- Billing, subscriptions, or anything that bills
- A hosted service, a dashboard, or a control plane

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
