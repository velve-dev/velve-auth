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

## The driver interface

Every statement the library runs goes through one small interface. The driver is
a parameter of `createVelveAuth`, never an import of the core, so the core has no
database dependency of its own.

```ts
interface Driver {
	query<T>(sql: string, params: unknown[]): Promise<T[]>;
	transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T>;
}
```

| Member | Parameters | Returns |
|---|---|---|
| `query` | `sql` — a single statement with `$1`-style placeholders; `params` — one value per placeholder | the result rows, in order |
| `transaction` | `fn` — receives a driver bound to the transaction's connection | whatever `fn` returns |

`transaction` commits when `fn` resolves and rolls back when it rejects. A driver
handed to `fn` is bound to one connection: statements it runs are inside the
transaction. Calling `transaction` on that bound driver joins the open
transaction rather than starting a second one, so a helper that wants a
transaction can be called from inside one.

There is no query builder and no ORM. All SQL is written by hand for PostgreSQL
14 or newer.

### `@velve/auth/pg`

```ts
import { Pool } from "pg";
import { createNodePostgresDriver } from "@velve/auth/pg";

const driver = createNodePostgresDriver(new Pool({ connectionString }));
```

`createNodePostgresDriver(pool)` returns a `Driver`. The pool is created, owned
and closed by the application; the library never opens a connection and never
reads a connection string.

`pg` is not a dependency of this package. The parameter is typed structurally, so
a `Pool` from `node-postgres` satisfies it without the package being installed:

| Type | Shape |
|---|---|
| `NodePostgresQueryConfig` | `{ text: string; values: unknown[] }` |
| `NodePostgresResult` | `{ rows: unknown[] }` |
| `NodePostgresClient` | `query(config)`, `release()` |
| `NodePostgresPool` | `query(config)`, `connect()` |

`query` outside a transaction runs on a pooled connection. `transaction` checks
out one connection, runs `BEGIN`, calls the body, and runs `COMMIT`; if the body
throws, it runs `ROLLBACK` and rethrows the body's error. The connection is
released in both cases. A failing `ROLLBACK` does not replace the error that
caused it.

### Identifiers

`schema` and table names reach SQL as identifiers, never as parameters, so they
are checked before use. A name must match `^[a-z_][a-z0-9_$]*$` and stay within
63 bytes; anything else raises `InvalidIdentifierError` with the code
`invalid_identifier`. Mixed-case and quoted identifiers are rejected rather than
quoted — there is no case in which the library needs one.
