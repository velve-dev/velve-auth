## client.d.mts

export { };

## http.d.mts

import { WebHandlerOptions, toWebHandler } from "./core/http/web-handler.mjs";
export { type WebHandlerOptions, toWebHandler };

## import.d.mts

export { };

## index.d.mts

import { Actor, ResolvedSession, actorOfResolvedSession } from "./core/db/actor.mjs";
import { OwnedRowRepository, OwnedRowRepositoryOptions, UnknownColumnError, createOwnedRowRepository } from "./core/db/repositories/owned-row-repository.mjs";

//#region src/index.d.ts
declare const VELVE_AUTH_VERSION = "0.0.0";
//#endregion
export { type Actor, type OwnedRowRepository, type OwnedRowRepositoryOptions, type ResolvedSession, UnknownColumnError, VELVE_AUTH_VERSION, actorOfResolvedSession, createOwnedRowRepository };

## neon.d.mts

export { };

## pg.d.mts

import { Driver } from "./core/db/driver.mjs";

//#region src/pg/index.d.ts
interface NodePostgresQueryConfig {
  text: string;
  values: unknown[];
}
interface NodePostgresResult {
  rows: unknown[];
}
interface NodePostgresClient {
  query(config: NodePostgresQueryConfig): Promise<NodePostgresResult>;
  release(): void;
}
interface NodePostgresPool {
  query(config: NodePostgresQueryConfig): Promise<NodePostgresResult>;
  connect(): Promise<NodePostgresClient>;
}
declare function createNodePostgresDriver(pool: NodePostgresPool): Driver;
//#endregion
export { NodePostgresClient, NodePostgresPool, NodePostgresQueryConfig, NodePostgresResult, createNodePostgresDriver };

## postgres-js.d.mts

export { };

## schema.d.mts

import { Driver } from "./core/db/driver.mjs";
import { MissingCascadeError } from "./core/db/cascade-guard.mjs";
import { InvalidIdentifierError } from "./core/db/identifier.mjs";
import { AppliedMigration, Migration, MigrationReport } from "./core/db/migration.mjs";
import { MigrationRefusedError, MigrationRunnerOptions, runMigrations } from "./core/db/migration-runner.mjs";
import { IdentityMode } from "./core/db/migrations/identity-mode.mjs";
import { coreMigrations } from "./core/db/migrations/index.mjs";
import { UnrewritableMigrationError } from "./core/db/schema-rewrite.mjs";
import { SchemaStatus, SchemaStatusOptions, SchemaVersionMismatchError, assertSchemaUpToDate, readSchemaStatus } from "./core/db/schema-status.mjs";
export { type AppliedMigration, type Driver, type IdentityMode, InvalidIdentifierError, type Migration, MigrationRefusedError, type MigrationReport, type MigrationRunnerOptions, MissingCascadeError, type SchemaStatus, type SchemaStatusOptions, SchemaVersionMismatchError, UnrewritableMigrationError, assertSchemaUpToDate, coreMigrations, readSchemaStatus, runMigrations };

## testing.d.mts

export { };