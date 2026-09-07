import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { assertEveryUserReferenceCascades } from "./cascade-guard.js";
import type { Driver } from "./driver.js";
import { assertSchemaName, qualifiedTableName } from "./identifier.js";
import {
	type AppliedMigration,
	type Migration,
	type MigrationReport,
	migrationChecksum,
} from "./migration.js";
import { applySchemaName } from "./schema-rewrite.js";

const DEFAULT_SCHEMA = "velve";
const LEDGER_TABLE = "schema_migration";
const ADVISORY_LOCK_NAMESPACE = 0x76656c76;

type MigrationRefusalCode = "migration_duplicate_version" | "migration_checksum_changed";

export class MigrationRefusedError extends Error {
	readonly code: MigrationRefusalCode;

	constructor(code: MigrationRefusalCode, message: string) {
		super(message);
		this.name = "MigrationRefusedError";
		this.code = code;
	}
}

interface MigrationRunnerOptions {
	readonly driver: Driver;
	readonly migrations: readonly Migration[];
	readonly schema?: string;
}

function schemaLockKey(schema: string): number {
	const digest = sha256(utf8ToBytes(schema));
	return new DataView(digest.buffer, digest.byteOffset, digest.byteLength).getInt32(0);
}

function inVersionOrder(migrations: readonly Migration[]): readonly Migration[] {
	const seen = new Map<number, string>();
	for (const migration of migrations) {
		const previous = seen.get(migration.version);
		if (previous !== undefined) {
			throw new MigrationRefusedError(
				"migration_duplicate_version",
				`version ${migration.version} is claimed by both "${previous}" and "${migration.name}"`,
			);
		}
		seen.set(migration.version, migration.name);
	}
	return [...migrations].sort((left, right) => left.version - right.version);
}

function assertChecksumUnchanged(migration: Migration, applied: AppliedMigration): void {
	const checksum = migrationChecksum(migration);
	if (applied.checksum !== checksum) {
		throw new MigrationRefusedError(
			"migration_checksum_changed",
			`migration ${migration.version} "${applied.name}" was applied with checksum ${applied.checksum} and now hashes to ${checksum}`,
		);
	}
}

async function lockSchema(tx: Driver, schema: string): Promise<void> {
	await tx.query("SELECT pg_advisory_xact_lock($1, $2)", [
		ADVISORY_LOCK_NAMESPACE,
		schemaLockKey(schema),
	]);
}

async function createLedger(driver: Driver, schema: string): Promise<void> {
	const ledger = qualifiedTableName(schema, LEDGER_TABLE);
	await driver.transaction(async (tx) => {
		await lockSchema(tx, schema);
		await tx.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`, []);
		await tx.query(
			`CREATE TABLE IF NOT EXISTS ${ledger} (
				version integer PRIMARY KEY,
				name text NOT NULL,
				applied_at timestamptz NOT NULL DEFAULT now(),
				checksum text NOT NULL
			)`,
			[],
		);
	});
}

async function readLedger(driver: Driver, schema: string): Promise<AppliedMigration[]> {
	return driver.query<AppliedMigration>(
		`SELECT version, name, checksum FROM ${qualifiedTableName(schema, LEDGER_TABLE)} ORDER BY version`,
		[],
	);
}

async function applyMigration(
	driver: Driver,
	schema: string,
	migration: Migration,
): Promise<boolean> {
	const ledger = qualifiedTableName(schema, LEDGER_TABLE);
	return driver.transaction(async (tx) => {
		await lockSchema(tx, schema);

		const [alreadyApplied] = await tx.query<AppliedMigration>(
			`SELECT version, name, checksum FROM ${ledger} WHERE version = $1`,
			[migration.version],
		);
		if (alreadyApplied !== undefined) {
			assertChecksumUnchanged(migration, alreadyApplied);
			return false;
		}

		await tx.query(applySchemaName(migration.sql, schema), []);
		await assertEveryUserReferenceCascades(tx, schema);
		await tx.query(`INSERT INTO ${ledger} (version, name, checksum) VALUES ($1, $2, $3)`, [
			migration.version,
			migration.name,
			migrationChecksum(migration),
		]);
		return true;
	});
}

export async function runMigrations(options: MigrationRunnerOptions): Promise<MigrationReport> {
	const schema = assertSchemaName(options.schema ?? DEFAULT_SCHEMA);
	const plan = inVersionOrder(options.migrations);

	await createLedger(options.driver, schema);

	const applied = new Map(
		(await readLedger(options.driver, schema)).map((row) => [row.version, row]),
	);
	for (const migration of plan) {
		const previously = applied.get(migration.version);
		if (previously !== undefined) {
			assertChecksumUnchanged(migration, previously);
		}
	}

	const appliedVersions: number[] = [];
	for (const migration of plan) {
		if (await applyMigration(options.driver, schema, migration)) {
			appliedVersions.push(migration.version);
		}
	}

	const versions = (await readLedger(options.driver, schema)).map((row) => row.version);
	return {
		appliedVersions,
		currentVersion: versions.length === 0 ? 0 : Math.max(...versions),
	};
}
