import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { assertEveryUserReferenceCascades } from "./cascade-guard.js";
import type { Driver } from "./driver.js";
import { assertSchemaName, qualifiedTableName } from "./identifier.js";
import {
	type AppliedMigration,
	CORE_LEDGER_TABLE,
	isOwnedMigration,
	type Migration,
	type MigrationReport,
	migrationChecksum,
	type OwnedMigration,
	PLUGIN_LEDGER_TABLE,
	type RunnableMigration,
} from "./migration.js";
import {
	applySchemaName,
	assertNoSchemaNameInsideDollarQuoting,
	splitStatements,
} from "./schema-rewrite.js";

const DEFAULT_SCHEMA = "velve";
const ADVISORY_LOCK_NAMESPACE = 0x76656c76;

/** The tables of the configured schema, which is the one schema the runner has to itself. */
const TABLES_OF_THE_SCHEMA = `
SELECT child.relname AS table_name
FROM pg_class child
JOIN pg_namespace namespace_ ON namespace_.oid = child.relnamespace
WHERE namespace_.nspname = $1 AND child.relkind IN ('r', 'p')`;

/**
 * Every table this transaction created or altered, in any schema, read out of the catalogue rows it
 * wrote rather than out of a before-and-after picture of the database — a picture of every schema
 * is a picture of other people's work, and it moves while a migration runs (E-660).
 */
const TABLES_THIS_TRANSACTION_TOUCHED = `
SELECT namespace_.nspname AS schema_name, child.relname AS table_name
FROM pg_class child
JOIN pg_namespace namespace_ ON namespace_.oid = child.relnamespace
WHERE child.relkind IN ('r', 'p')
  AND (child.xmin = pg_current_xact_id()::xid
       OR EXISTS (SELECT 1 FROM pg_attribute column_
                  WHERE column_.attrelid = child.oid
                    AND column_.xmin = pg_current_xact_id()::xid))`;

/**
 * The rows written into each user table, as the backend has them so far. A catalogue row cannot
 * show a row of data, so it cannot show a migration that disables every account in one statement —
 * writing a core table is the thing 3.11 forbids in so many words (E-661). It is read twice and
 * differenced: the counters carry whatever the backend has not yet reported, which reaches back
 * before this transaction began. The statement this sentence may not quote is E-768's rule, met a
 * second time (E-662).
 */
const ROWS_WRITTEN_SO_FAR = `
SELECT schemaname AS schema_name, relname AS table_name,
       n_tup_ins + n_tup_upd + n_tup_del AS written
FROM pg_stat_xact_user_tables`;

/** The counters above are kept only while `track_counts` is on, and a check that cannot run is not a pass. */
const COUNTERS_ARE_KEPT = "SELECT current_setting('track_counts') AS enabled";

type MigrationRefusalCode =
	| "migration_duplicate_version"
	| "migration_checksum_changed"
	| "migration_table_undeclared"
	| "migration_table_unprefixed"
	| "migration_table_outside_the_schema"
	| "migration_foreign_table_changed"
	| "migration_wrote_a_foreign_table"
	| "migration_write_check_unavailable";

export class MigrationRefusedError extends Error {
	readonly code: MigrationRefusalCode;

	constructor(code: MigrationRefusalCode, message: string) {
		super(message);
		this.name = "MigrationRefusedError";
		this.code = code;
	}
}

export interface MigrationRunnerOptions {
	readonly driver: Driver;
	readonly migrations: readonly RunnableMigration[];
	readonly schema?: string;
}

interface WrittenTableRow {
	readonly schema_name: string;
	readonly table_name: string;
	readonly written: number;
}

/** The rows written per table, keyed `schema.table`, as at the moment it was read. */
type WriteCounters = ReadonlyMap<string, number>;

function schemaLockKey(schema: string): number {
	const digest = sha256(utf8ToBytes(schema));
	return new DataView(digest.buffer, digest.byteOffset, digest.byteLength).getInt32(0);
}

function assertNoVersionIsClaimedTwice(migrations: readonly Migration[], owner: string): void {
	const seen = new Map<number, string>();
	for (const migration of migrations) {
		const previous = seen.get(migration.version);
		if (previous !== undefined) {
			throw new MigrationRefusedError(
				"migration_duplicate_version",
				`${owner} version ${migration.version} is claimed by both "${previous}" and "${migration.name}"`,
			);
		}
		seen.set(migration.version, migration.name);
	}
}

function inVersionOrder<T extends Migration>(
	migrations: readonly T[],
	owner: string,
): readonly T[] {
	assertNoVersionIsClaimedTwice(migrations, owner);
	return [...migrations].sort((left, right) => left.version - right.version);
}

/** Each plugin's migrations run together, in the dependency order the registry handed them over in. */
function byOwnerInDependencyOrder(
	migrations: readonly OwnedMigration[],
): readonly OwnedMigration[] {
	const byOwner = new Map<string, OwnedMigration[]>();
	for (const migration of migrations) {
		const owned = byOwner.get(migration.owner);
		if (owned === undefined) {
			byOwner.set(migration.owner, [migration]);
			continue;
		}
		owned.push(migration);
	}
	return [...byOwner].flatMap(([owner, owned]) => inVersionOrder(owned, owner));
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

async function createLedgers(
	driver: Driver,
	schema: string,
	withPluginLedger: boolean,
): Promise<void> {
	await driver.transaction(async (tx) => {
		await lockSchema(tx, schema);
		await tx.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`, []);
		await tx.query(
			`CREATE TABLE IF NOT EXISTS ${qualifiedTableName(schema, CORE_LEDGER_TABLE)} (
				version integer PRIMARY KEY,
				name text NOT NULL,
				applied_at timestamptz NOT NULL DEFAULT now(),
				checksum text NOT NULL
			)`,
			[],
		);
		if (withPluginLedger) {
			await tx.query(
				`CREATE TABLE IF NOT EXISTS ${qualifiedTableName(schema, PLUGIN_LEDGER_TABLE)} (
					plugin_id text NOT NULL,
					version integer NOT NULL,
					name text NOT NULL,
					applied_at timestamptz NOT NULL DEFAULT now(),
					checksum text NOT NULL,
					PRIMARY KEY (plugin_id, version)
				)`,
				[],
			);
		}
	});
}

async function readLedger(driver: Driver, schema: string): Promise<AppliedMigration[]> {
	return driver.query<AppliedMigration>(
		`SELECT version, name, checksum FROM ${qualifiedTableName(schema, CORE_LEDGER_TABLE)} ORDER BY version`,
		[],
	);
}

async function readWriteCounters(tx: Driver, migration: OwnedMigration): Promise<WriteCounters> {
	const [counters] = await tx.query<{ enabled: string }>(COUNTERS_ARE_KEPT, []);
	if (counters?.enabled !== "on") {
		refuseOwned(
			"migration_write_check_unavailable",
			migration,
			"track_counts is off, so what the migration wrote cannot be read",
		);
	}
	const written = new Map<string, number>();
	for (const row of await tx.query<WrittenTableRow>(ROWS_WRITTEN_SO_FAR, [])) {
		written.set(`${row.schema_name}.${row.table_name}`, Number(row.written));
	}
	return written;
}

async function readTableNames(tx: Driver, schema: string): Promise<ReadonlySet<string>> {
	const rows = await tx.query<{ table_name: string }>(TABLES_OF_THE_SCHEMA, [schema]);
	return new Set(rows.map((row) => `${schema}.${row.table_name}`));
}

async function readTablesTouched(tx: Driver): Promise<readonly string[]> {
	const rows = await tx.query<WrittenTableRow>(TABLES_THIS_TRANSACTION_TOUCHED, []);
	return rows.map((row) => `${row.schema_name}.${row.table_name}`).sort();
}

function refuseOwned(code: MigrationRefusalCode, migration: OwnedMigration, what: string): never {
	throw new MigrationRefusedError(
		code,
		`refusing migration ${migration.version} "${migration.name}" of plugin ${migration.owner}: ${what}`,
	);
}

/** 3.11: a plugin's tables are the ones in the configured schema carrying its own prefix. */
function isOwnedTable(qualified: string, migration: OwnedMigration, schema: string): boolean {
	return qualified.startsWith(`${schema}.${migration.owner}_`);
}

function localNameOf(qualified: string): string {
	return qualified.slice(qualified.indexOf(".") + 1);
}

/**
 * What a migration did is measured rather than read out of its SQL, so a statement the runner
 * cannot parse cannot get past the declaration either (E-637). Outside the plugin's own tables
 * nothing may be created, altered or removed; inside them the plugin may do as it likes, which is
 * what lets a later migration alter a table an earlier one created (E-660).
 */
function assertNothingButItsOwnTablesChanged(
	migration: OwnedMigration,
	schema: string,
	before: ReadonlySet<string>,
	after: ReadonlySet<string>,
	touched: readonly string[],
): void {
	for (const table of touched) {
		if (isOwnedTable(table, migration, schema)) {
			continue;
		}
		if (!table.startsWith(`${schema}.`)) {
			refuseOwned(
				"migration_table_outside_the_schema",
				migration,
				`it reached ${table}, and a plugin's tables live in ${schema}`,
			);
		}
		refuseOwned(
			before.has(table) ? "migration_foreign_table_changed" : "migration_table_unprefixed",
			migration,
			`it reached ${table}, which is not one of the tables named ${migration.owner}_`,
		);
	}

	for (const table of before) {
		if (!after.has(table) && !isOwnedTable(table, migration, schema)) {
			refuseOwned("migration_foreign_table_changed", migration, `it removed ${table}`);
		}
	}

	const declared = [...new Set(migration.createsTables)].sort();
	const appeared = [...after]
		.filter((table) => !before.has(table))
		.map(localNameOf)
		.sort();
	if (appeared.join(",") !== declared.join(",")) {
		refuseOwned(
			"migration_table_undeclared",
			migration,
			`it declares [${declared.join(", ")}] and created [${appeared.join(", ")}]`,
		);
	}
}

/**
 * The row-level half, as the difference between two readings, because the counters are the
 * backend's pending totals rather than this transaction's alone (E-661).
 */
function assertNoForeignTableWasWritten(
	migration: OwnedMigration,
	schema: string,
	before: WriteCounters,
	after: WriteCounters,
): void {
	for (const [table, written] of after) {
		if (written > (before.get(table) ?? 0) && !isOwnedTable(table, migration, schema)) {
			refuseOwned("migration_wrote_a_foreign_table", migration, `it wrote rows in ${table}`);
		}
	}
}

async function applyStatements(tx: Driver, schema: string, migration: Migration): Promise<void> {
	for (const statement of splitStatements(applySchemaName(migration.sql, schema))) {
		await tx.query(statement, []);
	}
	await assertEveryUserReferenceCascades(tx, schema);
}

async function applyMigration(
	driver: Driver,
	schema: string,
	migration: Migration,
): Promise<boolean> {
	const ledger = qualifiedTableName(schema, CORE_LEDGER_TABLE);
	assertNoSchemaNameInsideDollarQuoting(migration.sql, schema);
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

		await applyStatements(tx, schema, migration);
		await tx.query(`INSERT INTO ${ledger} (version, name, checksum) VALUES ($1, $2, $3)`, [
			migration.version,
			migration.name,
			migrationChecksum(migration),
		]);
		return true;
	});
}

async function applyOwnedMigration(
	driver: Driver,
	schema: string,
	migration: OwnedMigration,
): Promise<void> {
	const ledger = qualifiedTableName(schema, PLUGIN_LEDGER_TABLE);
	assertNoSchemaNameInsideDollarQuoting(migration.sql, schema);
	await driver.transaction(async (tx) => {
		await lockSchema(tx, schema);

		const [alreadyApplied] = await tx.query<AppliedMigration>(
			`SELECT version, name, checksum FROM ${ledger} WHERE plugin_id = $1 AND version = $2`,
			[migration.owner, migration.version],
		);
		if (alreadyApplied !== undefined) {
			assertChecksumUnchanged(migration, alreadyApplied);
			return;
		}

		const writtenBefore = await readWriteCounters(tx, migration);
		const before = await readTableNames(tx, schema);
		await applyStatements(tx, schema, migration);
		assertNoForeignTableWasWritten(
			migration,
			schema,
			writtenBefore,
			await readWriteCounters(tx, migration),
		);
		assertNothingButItsOwnTablesChanged(
			migration,
			schema,
			before,
			await readTableNames(tx, schema),
			await readTablesTouched(tx),
		);
		await tx.query(
			`INSERT INTO ${ledger} (plugin_id, version, name, checksum) VALUES ($1, $2, $3, $4)`,
			[migration.owner, migration.version, migration.name, migrationChecksum(migration)],
		);
	});
}

export async function runMigrations(options: MigrationRunnerOptions): Promise<MigrationReport> {
	const schema = assertSchemaName(options.schema ?? DEFAULT_SCHEMA);
	const owned = byOwnerInDependencyOrder(options.migrations.filter(isOwnedMigration));
	const plan = inVersionOrder(
		options.migrations.filter((migration) => !isOwnedMigration(migration)),
		schema,
	);

	await createLedgers(options.driver, schema, owned.length > 0);

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

	// The core schema is what a plugin's tables reference, so every core migration is applied first.
	for (const migration of owned) {
		await applyOwnedMigration(options.driver, schema, migration);
	}

	const versions = (await readLedger(options.driver, schema)).map((row) => row.version);
	return {
		appliedVersions,
		currentVersion: versions.length === 0 ? 0 : Math.max(...versions),
	};
}
