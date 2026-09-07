## client.d.mts

export { };

## http.d.mts

export { };

## import.d.mts

export { };

## index.d.mts

//#region src/index.d.ts
declare const VELVE_AUTH_VERSION = "0.0.0";
//#endregion
export { VELVE_AUTH_VERSION };

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

export { };

## testing.d.mts

export { };