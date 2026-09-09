import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export interface Migration {
	readonly version: number;
	readonly name: string;
	readonly sql: string;
}

/**
 * 3.11 puts a plugin's migrations in the same versioned runner. `owner` is what makes the version
 * space the plugin's own, so 3.15 G.1's example numbering its first migration `1` no longer
 * collides with the core's first (E-635).
 */
export interface OwnedMigration extends Migration {
	readonly owner: string;
	readonly createsTables: readonly string[];
}

export type RunnableMigration = Migration | OwnedMigration;

/** `Object.hasOwn` and not `in`, so no prototype decides which ledger a migration is recorded in (E-657). */
export function isOwnedMigration(migration: RunnableMigration): migration is OwnedMigration {
	return Object.hasOwn(migration, "owner");
}

/** The core's ledger, created before the runner can read it, and named by migration 1 as well. */
export const CORE_LEDGER_TABLE = "schema_migration";

/**
 * The plugins' ledger, keyed on the plugin and its own version. It is created only where a plugin
 * migration runs, so a schema without plugins is the one the shipped SQL describes (E-636).
 */
export const PLUGIN_LEDGER_TABLE = "plugin_schema_migration";

export interface AppliedMigration {
	readonly version: number;
	readonly name: string;
	readonly checksum: string;
}

export interface MigrationReport {
	readonly appliedVersions: readonly number[];
	readonly currentVersion: number;
}

export function migrationChecksum(migration: Migration): string {
	return bytesToHex(sha256(utf8ToBytes(migration.sql)));
}
