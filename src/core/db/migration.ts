import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export interface Migration {
	readonly version: number;
	readonly name: string;
	readonly sql: string;
}

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
