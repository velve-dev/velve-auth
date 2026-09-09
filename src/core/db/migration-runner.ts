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

/**
 * Every relation of the configured schema, of every kind — a view, an index and a sequence are
 * relations too, and reading only tables left `DROP INDEX velve.user_email_key` invisible (E-903).
 */
const RELATIONS_OF_THE_SCHEMA = `
SELECT child.relname AS table_name, child.relkind::text AS kind
FROM pg_class child
JOIN pg_namespace namespace_ ON namespace_.oid = child.relnamespace
WHERE namespace_.nspname = $1 AND child.relkind <> 't'`;

/**
 * Every table this transaction created or altered, in any schema, read out of the catalogue rows it
 * wrote rather than out of a before-and-after picture of the database — a picture of every schema
 * is a picture of other people's work, and it moves while a migration runs (E-664).
 */
const TABLES_THIS_TRANSACTION_TOUCHED = `
SELECT namespace_.nspname AS schema_name, child.relname AS table_name,
       child.relkind::text AS kind
FROM pg_class child
JOIN pg_namespace namespace_ ON namespace_.oid = child.relnamespace
WHERE child.relkind <> 't'
  AND namespace_.nspname NOT LIKE 'pg_toast%'
  AND namespace_.nspname NOT LIKE 'pg_temp%'
  AND (child.xmin = pg_current_xact_id()::xid
       OR EXISTS (SELECT 1 FROM pg_attribute column_
                  WHERE column_.attrelid = child.oid
                    AND column_.xmin = pg_current_xact_id()::xid))`;

/**
 * The code this transaction left behind. A function, a trigger and a rewrite rule are none of them
 * relations, so the catalogue above cannot see them, and a trigger on `velve.user` is executable
 * code on every write to a core table (E-903).
 */
const CODE_THIS_TRANSACTION_LEFT = `
SELECT 'a function' AS kind, namespace_.nspname AS schema_name, routine.proname AS name
FROM pg_proc routine
JOIN pg_namespace namespace_ ON namespace_.oid = routine.pronamespace
WHERE routine.xmin = pg_current_xact_id()::xid
UNION ALL
SELECT 'a trigger on ' || namespace_.nspname || '.' || target.relname, namespace_.nspname,
       trigger_.tgname
FROM pg_trigger trigger_
JOIN pg_class target ON target.oid = trigger_.tgrelid
JOIN pg_namespace namespace_ ON namespace_.oid = target.relnamespace
WHERE trigger_.xmin = pg_current_xact_id()::xid AND NOT trigger_.tgisinternal
UNION ALL
SELECT 'a rule on ' || namespace_.nspname || '.' || target.relname, namespace_.nspname, rule_.rulename
FROM pg_rewrite rule_
JOIN pg_class target ON target.oid = rule_.ev_class
JOIN pg_namespace namespace_ ON namespace_.oid = target.relnamespace
WHERE rule_.xmin = pg_current_xact_id()::xid AND rule_.rulename <> '_RETURN'`;

/** The tables the plugin's own tables point at, which are the ones a write of its own may read. */
const TABLES_ITS_OWN_TABLES_REFERENCE = `
SELECT DISTINCT referenced_ns.nspname AS schema_name, referenced.relname AS table_name
FROM pg_constraint constraint_
JOIN pg_class child ON child.oid = constraint_.conrelid
JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
JOIN pg_class referenced ON referenced.oid = constraint_.confrelid
JOIN pg_namespace referenced_ns ON referenced_ns.oid = referenced.relnamespace
WHERE constraint_.contype = 'f' AND child_ns.nspname = $1 AND child.relname LIKE $2`;

/**
 * The rows written into each user table, as the backend has them so far. A catalogue row cannot
 * show a row of data, so it cannot show a migration that disables every account in one statement —
 * writing a core table is the thing 3.11 forbids in so many words (E-664). It is read twice and
 * differenced: the counters carry whatever the backend has not yet reported, which reaches back
 * before this transaction began. The statement this sentence may not quote is E-768's rule, met a
 * second time (E-664).
 */
const ROWS_WRITTEN_SO_FAR = `
SELECT schemaname AS schema_name, relname AS table_name,
       n_tup_ins + n_tup_upd + n_tup_del AS written,
       coalesce(seq_scan, 0) + coalesce(idx_scan, 0) AS scanned
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
	| "migration_read_a_foreign_table"
	| "migration_left_code_behind"
	| "migration_created_more_than_a_table"
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
	readonly scanned: number;
}

interface RelationRow {
	readonly schema_name: string;
	readonly table_name: string;
	readonly kind: string;
}

interface CodeRow {
	readonly kind: string;
	readonly schema_name: string;
	readonly name: string;
}

interface TableCounters {
	readonly written: number;
	readonly scanned: number;
}

/** What each table had written into it and read out of it, keyed `schema.table`, when it was read. */
type WriteCounters = ReadonlyMap<string, TableCounters>;

/** A relation of the plugin's own: a table, an index, a sequence, and nothing that carries a query. */
const KINDS_A_TABLE_BRINGS_WITH_IT = new Set(["r", "p", "i", "I", "S"]);
const TABLE_KINDS = new Set(["r", "p"]);

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
	const written = new Map<string, TableCounters>();
	for (const row of await tx.query<WrittenTableRow>(ROWS_WRITTEN_SO_FAR, [])) {
		written.set(`${row.schema_name}.${row.table_name}`, {
			written: Number(row.written),
			scanned: Number(row.scanned),
		});
	}
	return written;
}

type Relations = ReadonlyMap<string, string>;

async function readRelations(tx: Driver, schema: string): Promise<Relations> {
	const rows = await tx.query<RelationRow>(RELATIONS_OF_THE_SCHEMA, [schema]);
	return new Map(rows.map((row) => [`${schema}.${row.table_name}`, row.kind]));
}

async function readRelationsTouched(tx: Driver): Promise<Relations> {
	const rows = await tx.query<RelationRow>(TABLES_THIS_TRANSACTION_TOUCHED, []);
	return new Map(rows.map((row) => [`${row.schema_name}.${row.table_name}`, row.kind]));
}

async function readTablesItMayRead(
	tx: Driver,
	migration: OwnedMigration,
	schema: string,
): Promise<ReadonlySet<string>> {
	const rows = await tx.query<RelationRow>(TABLES_ITS_OWN_TABLES_REFERENCE, [
		schema,
		`${migration.owner}_%`,
	]);
	return new Set(rows.map((row) => `${row.schema_name}.${row.table_name}`));
}

function refuseOwned(code: MigrationRefusalCode, migration: OwnedMigration, what: string): never {
	throw new MigrationRefusedError(
		code,
		`refusing migration ${migration.version} "${migration.name}" of plugin ${migration.owner}: ${what}`,
	);
}

/** 3.11: a plugin's own objects are the ones in the configured schema carrying its own prefix. */
function isOwnedTable(qualified: string, migration: OwnedMigration, schema: string): boolean {
	return qualified.startsWith(`${schema}.${migration.owner}_`);
}

function localNameOf(qualified: string): string {
	return qualified.slice(qualified.indexOf(".") + 1);
}

/** A relation the plugin does not own, in the schema or out of it, and however it got there. */
function refuseTheForeignRelation(
	migration: OwnedMigration,
	schema: string,
	relation: string,
	before: Relations,
): never {
	if (!relation.startsWith(`${schema}.`)) {
		refuseOwned(
			"migration_table_outside_the_schema",
			migration,
			`it reached ${relation}, and a plugin's tables live in ${schema}`,
		);
	}
	refuseOwned(
		before.has(relation) ? "migration_foreign_table_changed" : "migration_table_unprefixed",
		migration,
		`it reached ${relation}, which is not one of the tables named ${migration.owner}_`,
	);
}

/**
 * What a migration did is measured rather than read out of its SQL, so a statement the runner
 * cannot parse cannot get past the declaration either (E-637). Outside the plugin's own relations
 * nothing may be created, altered or removed; inside them the plugin may do as it likes, which is
 * what lets a later migration alter a table an earlier one created (E-664). A relation of its own
 * that is not a table, or one of the objects a table brings with it, is refused whatever it is
 * called: a view carries a query, and a query of its own reads what it likes (E-903).
 */
function assertEveryRelationItTouchedIsItsOwn(
	migration: OwnedMigration,
	schema: string,
	before: Relations,
	touched: Relations,
): void {
	for (const [relation, kind] of touched) {
		if (!isOwnedTable(relation, migration, schema)) {
			refuseTheForeignRelation(migration, schema, relation, before);
		}
		if (!KINDS_A_TABLE_BRINGS_WITH_IT.has(kind)) {
			refuseOwned(
				"migration_created_more_than_a_table",
				migration,
				`it made ${relation} a relation of kind "${kind}", and 3.11 gives a plugin tables`,
			);
		}
	}
}

function assertItRemovedNothingOfAnybodyElses(
	migration: OwnedMigration,
	schema: string,
	before: Relations,
	after: Relations,
): void {
	for (const relation of before.keys()) {
		if (!after.has(relation) && !isOwnedTable(relation, migration, schema)) {
			refuseOwned("migration_foreign_table_changed", migration, `it removed ${relation}`);
		}
	}
}

function assertTheTablesThatAppearedAreTheDeclaredOnes(
	migration: OwnedMigration,
	before: Relations,
	after: Relations,
): void {
	const declared = [...new Set(migration.createsTables)].sort();
	const appeared = [...after]
		.filter(([relation, kind]) => !before.has(relation) && TABLE_KINDS.has(kind))
		.map(([relation]) => localNameOf(relation))
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
 * A function, a trigger and a rule are not relations and the catalogue of relations cannot see
 * them. None of the three is a table, so a migration that leaves one behind is refused whatever it
 * is attached to — the one on a core table would run on every write to it (E-903).
 */
function assertNoCodeWasLeftBehind(migration: OwnedMigration, left: readonly CodeRow[]): void {
	for (const object of left) {
		refuseOwned(
			"migration_left_code_behind",
			migration,
			`it left ${object.kind} behind, ${object.schema_name}.${object.name}`,
		);
	}
}

/**
 * The row-level half, as the difference between two readings, because the counters are the
 * backend's pending totals rather than this transaction's alone (E-664). A read is measured beside
 * a write: a plugin that may not write a core table may not copy one into a table of its own
 * either, and a view was one way of doing that (E-903). What it may read is its own tables and the
 * ones they reference, because a foreign key is checked by reading the table it points at.
 */
function assertNoForeignTableWasReachedByARow(
	migration: OwnedMigration,
	schema: string,
	before: WriteCounters,
	after: WriteCounters,
	mayRead: ReadonlySet<string>,
): void {
	const none: TableCounters = { written: 0, scanned: 0 };
	for (const [table, counters] of after) {
		const previously = before.get(table) ?? none;
		if (isOwnedTable(table, migration, schema)) {
			continue;
		}
		if (counters.written > previously.written) {
			refuseOwned("migration_wrote_a_foreign_table", migration, `it wrote rows in ${table}`);
		}
		if (counters.scanned > previously.scanned && !mayRead.has(table)) {
			refuseOwned("migration_read_a_foreign_table", migration, `it read rows of ${table}`);
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
		const before = await readRelations(tx, schema);
		await applyStatements(tx, schema, migration);
		// The ownership of what it touched is read first, so a relation it should not have made is
		// refused for what it is rather than for the scan that making it recorded.
		const after = await readRelations(tx, schema);
		assertEveryRelationItTouchedIsItsOwn(migration, schema, before, await readRelationsTouched(tx));
		assertItRemovedNothingOfAnybodyElses(migration, schema, before, after);
		assertTheTablesThatAppearedAreTheDeclaredOnes(migration, before, after);
		assertNoCodeWasLeftBehind(migration, await tx.query<CodeRow>(CODE_THIS_TRANSACTION_LEFT, []));
		assertNoForeignTableWasReachedByARow(
			migration,
			schema,
			writtenBefore,
			await readWriteCounters(tx, migration),
			await readTablesItMayRead(tx, migration, schema),
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
