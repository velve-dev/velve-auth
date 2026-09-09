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
import { coreTableNameSet, namesTableOfPlugin } from "./migrations/index.js";
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
SELECT child.oid AS object_id, child.relname AS table_name, child.relkind::text AS kind,
       pg_describe_object('pg_class'::regclass, child.oid, 0) AS described
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
       child.relkind::text AS kind, child.oid AS object_id,
       pg_describe_object('pg_class'::regclass, child.oid, 0) AS described
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

/**
 * What the connected role may do regardless of anything measured here. `track_counts` takes a
 * superuser to change, and a superuser migration turns the row half off and on again around its own
 * statements without either reading of the guard seeing it; creating a role takes a superuser or
 * `CREATEROLE`, and a role needs no counters at all (E-920).
 */
const PRIVILEGES_OF_THE_CONNECTED_ROLE = `
SELECT rolsuper AS is_superuser, rolcreaterole AS creates_roles
FROM pg_roles WHERE rolname = current_user`;

/**
 * Every object that belongs to the schema, of every catalogue there is, walked from the schema
 * itself along the dependency edges rather than looked up in a list of names. Core migrations run
 * before any plugin migration, so what this answers before a plugin's transaction is the core — by
 * construction, with nothing to fall behind when a table, an index or a trigger is added (E-918).
 */
const OBJECTS_BELONGING_TO_THE_SCHEMA = `
WITH RECURSIVE belonging(classid, objid) AS (
  SELECT depend.classid, depend.objid
  FROM pg_depend depend
  JOIN pg_namespace namespace_ ON namespace_.oid = depend.refobjid
  WHERE depend.refclassid = 'pg_namespace'::regclass AND namespace_.nspname = $1
  UNION
  SELECT depend.classid, depend.objid
  FROM pg_depend depend
  JOIN belonging ON depend.refclassid = belonging.classid AND depend.refobjid = belonging.objid
)
SELECT classid::regclass::text AS catalogue, objid AS object_id,
       pg_describe_object(classid, objid, 0) AS described
FROM belonging`;

/**
 * The same walk from the tables the plugin declared, which is what it may alter and drop. The set
 * comes from `createsTables` rather than from the plugin's id, so it is not widened by choosing a
 * name (E-918).
 */
const OBJECTS_OF_THE_DECLARED_TABLES = `
WITH RECURSIVE belonging(classid, objid) AS (
  SELECT 'pg_class'::regclass, child.oid
  FROM pg_class child
  JOIN pg_namespace namespace_ ON namespace_.oid = child.relnamespace
  WHERE namespace_.nspname = $1 AND child.relname = ANY(string_to_array($2, ','))
  UNION
  SELECT depend.classid, depend.objid
  FROM pg_depend depend
  JOIN belonging ON depend.refclassid = belonging.classid AND depend.refobjid = belonging.objid
)
SELECT classid::regclass::text AS catalogue, objid AS object_id FROM belonging`;

/**
 * Every object this transaction created, of every catalogue there is, beside the object each one was
 * recorded as depending on. A migration that creates something PostgreSQL files nowhere this runner
 * has heard of still writes its dependency on the schema, and `pg_describe_object` names it in the
 * refusal — which is what makes the boundary a positive one rather than a list of catalogues to
 * lengthen after each release (E-909).
 */
const OBJECTS_THIS_TRANSACTION_CREATED = `
SELECT depend.classid::regclass::text AS catalogue, depend.objid AS object_id,
       depend.refclassid::regclass::text AS referenced_catalogue,
       depend.refobjid AS referenced_id,
       pg_describe_object(depend.classid, depend.objid, depend.objsubid) AS described
FROM pg_depend depend
WHERE depend.xmin = pg_current_xact_id()::xid`;

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
	| "migration_write_check_unavailable"
	| "migration_role_unbounded";

export class MigrationRefusedError extends Error {
	readonly code: MigrationRefusalCode;

	constructor(code: MigrationRefusalCode, message: string) {
		super(message);
		this.name = "MigrationRefusedError";
		this.code = code;
	}
}

/**
 * The library cannot check that a restricted migration role was provisioned — a role that does not
 * exist is indistinguishable from one that was never needed — but it can refuse a role too powerful
 * for anything measured here to bind. A missing provision is then a refusal and not a silent pass,
 * which is the property the role form was declined for lacking in E-909. Only plugin migrations are
 * refused; the core's own run on whatever connection the application supplies (E-920).
 */
async function assertTheRoleCannotOutrunTheMeasurement(driver: Driver): Promise<void> {
	const [role] = await driver.query<{ is_superuser: boolean; creates_roles: boolean }>(
		PRIVILEGES_OF_THE_CONNECTED_ROLE,
		[],
	);
	if (role === undefined) {
		throw new MigrationRefusedError(
			"migration_role_unbounded",
			"the privileges of the connected role could not be read, so what a plugin migration may do is unknown",
		);
	}
	if (role.is_superuser || role.creates_roles) {
		throw new MigrationRefusedError(
			"migration_role_unbounded",
			`a plugin migration does not run on a connection whose role ${role.is_superuser ? "is a superuser" : "may create roles"}: such a role can switch the measurements off, so run migrations as a role that holds neither`,
		);
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
	readonly object_id: number;
	readonly described: string;
}

interface BelongingRow {
	readonly catalogue: string;
	readonly object_id: number;
	readonly described: string;
}

interface DependencyRow {
	readonly catalogue: string;
	readonly object_id: number;
	readonly referenced_catalogue: string;
	readonly referenced_id: number;
	readonly described: string;
}

/** What a relation is, as the catalogue answers it: its kind, its identity and its readable name. */
interface RelationFact {
	readonly kind: string;
	readonly objectId: number;
	readonly described: string;
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

type Relations = ReadonlyMap<string, RelationFact>;

function factOf(row: RelationRow): RelationFact {
	return { kind: row.kind, objectId: Number(row.object_id), described: row.described };
}

async function readRelations(tx: Driver, schema: string): Promise<Relations> {
	const rows = await tx.query<RelationRow>(RELATIONS_OF_THE_SCHEMA, [schema]);
	return new Map(rows.map((row) => [`${schema}.${row.table_name}`, factOf(row)]));
}

async function readRelationsTouched(tx: Driver): Promise<Relations> {
	const rows = await tx.query<RelationRow>(TABLES_THIS_TRANSACTION_TOUCHED, []);
	return new Map(rows.map((row) => [`${row.schema_name}.${row.table_name}`, factOf(row)]));
}

type SchemaObjects = ReadonlyMap<string, string>;

function objectKey(catalogue: string, id: number): string {
	return `${catalogue}:${id}`;
}

async function readSchemaObjects(tx: Driver, schema: string): Promise<SchemaObjects> {
	const rows = await tx.query<BelongingRow>(OBJECTS_BELONGING_TO_THE_SCHEMA, [schema]);
	return new Map(
		rows.map((row) => [objectKey(row.catalogue, Number(row.object_id)), row.described]),
	);
}

async function readObjectsOfTheDeclaredTables(
	tx: Driver,
	schema: string,
	declared: readonly string[],
): Promise<ReadonlySet<string>> {
	if (declared.length === 0) {
		return new Set();
	}
	const rows = await tx.query<BelongingRow>(OBJECTS_OF_THE_DECLARED_TABLES, [
		schema,
		declared.join(","),
	]);
	return new Set(rows.map((row) => objectKey(row.catalogue, Number(row.object_id))));
}

function refuseOwned(code: MigrationRefusalCode, migration: OwnedMigration, what: string): never {
	throw new MigrationRefusedError(
		code,
		`refusing migration ${migration.version} "${migration.name}" of plugin ${migration.owner}: ${what}`,
	);
}

function localNameOf(qualified: string): string {
	return qualified.slice(qualified.indexOf(".") + 1);
}

/**
 * 3.11: a plugin's own tables are the ones it **declared**, not the ones whose names begin like its
 * id. No list of names decides anything here any more — a core table's name and a core index's name
 * are both simply names the plugin did not declare (E-918). The registry still requires every
 * declared name to carry the prefix and to be no core table's, so this set is the narrower of the
 * two boundaries and `ownTables.query` remains the wider.
 */
function isOwnedTable(qualified: string, declared: ReadonlySet<string>): boolean {
	return declared.has(qualified);
}

/**
 * Not a permission — a **diagnosis**. A relation carrying the prefix is one the plugin plainly meant
 * to make, so it is reported by the rule it actually broke: an undeclared table as undeclared, a
 * view by its kind, an index of its own by the census that finds no table of its own behind it. A
 * relation that carries no prefix was never plausibly its own and is reported as foreign. Permission
 * is decided by the declared set and by the snapshot, neither of which reads this (E-918).
 */
function carriesThePluginsPrefix(
	qualified: string,
	migration: OwnedMigration,
	schema: string,
): boolean {
	return (
		qualified.startsWith(`${schema}.`) &&
		namesTableOfPlugin(localNameOf(qualified), migration.owner)
	);
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
	const core = coreTableNameSet().has(localNameOf(relation));
	refuseOwned(
		before.has(relation) ? "migration_foreign_table_changed" : "migration_table_unprefixed",
		migration,
		core
			? `it reached ${relation}, which is a core table and is nobody's own however its name begins`
			: `it reached ${relation}, and a plugin migration reaches the tables it declared in createsTables and what those bring with them`,
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
	for (const [relation, fact] of touched) {
		if (!carriesThePluginsPrefix(relation, migration, schema)) {
			refuseTheForeignRelation(migration, schema, relation, before);
		}
		if (!KINDS_A_TABLE_BRINGS_WITH_IT.has(fact.kind)) {
			refuseOwned(
				"migration_created_more_than_a_table",
				migration,
				`it made ${fact.described}, and 3.11 gives a plugin tables, the indexes and sequences they bring with them, and nothing else`,
			);
		}
	}
}

/**
 * The objects that belong to the plugin's own tables, grown from those tables along the dependency
 * edges this transaction wrote. A table's row type, its array type, its indexes, its constraints,
 * its column defaults, its toast table and the internal triggers a foreign key installs all lead
 * back to it; a type, an extension or a function of its own leads to the schema and stops there.
 */
function objectsBelongingToTheOwnTables(
	created: readonly DependencyRow[],
	ownedRelations: ReadonlySet<string>,
): ReadonlySet<string> {
	const belonging = new Set(ownedRelations);
	for (let grew = true; grew; ) {
		grew = false;
		for (const row of created) {
			const key = objectKey(row.catalogue, Number(row.object_id));
			const target = objectKey(row.referenced_catalogue, Number(row.referenced_id));
			if (!belonging.has(key) && belonging.has(target)) {
				belonging.add(key);
				grew = true;
			}
		}
	}
	return belonging;
}

/**
 * The half of the boundary that is stated positively: whatever a migration created has to belong to
 * one of the plugin's own tables. The three catalogues read above are a list of the things a
 * migration may not leave behind, and PostgreSQL adds object kinds faster than such a list is
 * extended — an enumerated type and a composite type were both accepted by it (E-909).
 */
function assertEveryObjectItCreatedBelongsToItsOwnTables(
	migration: OwnedMigration,
	created: readonly DependencyRow[],
	ownedRelations: ReadonlySet<string>,
): void {
	const belonging = objectsBelongingToTheOwnTables(created, ownedRelations);
	for (const row of created) {
		if (!belonging.has(objectKey(row.catalogue, Number(row.object_id)))) {
			refuseOwned(
				"migration_created_more_than_a_table",
				migration,
				`it created ${row.described}, which belongs to none of its own tables, and 3.11 gives a plugin tables`,
			);
		}
	}
}

/**
 * Everything that was in the schema before the plugin's transaction and is not the plugin's own has
 * to be there afterwards, under the same name. It replaces a walk over relations that could not see
 * a dropped trigger or a dropped function at all — S-FIX-2 puts half its enforcement in one of each
 * — and it needs no list of what the core owns, because before a plugin migration runs everything
 * present is the core's (E-918).
 */
function assertItLeftEveryOtherObjectAsItFoundIt(
	migration: OwnedMigration,
	before: SchemaObjects,
	after: SchemaObjects,
	own: ReadonlySet<string>,
): void {
	for (const [key, described] of before) {
		if (own.has(key)) {
			continue;
		}
		const now = after.get(key);
		if (now === undefined) {
			refuseOwned("migration_foreign_table_changed", migration, `it removed ${described}`);
		}
		if (now !== described) {
			refuseOwned(
				"migration_foreign_table_changed",
				migration,
				`it renamed ${described}, which is now ${now}`,
			);
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
		.filter(([relation, fact]) => !before.has(relation) && TABLE_KINDS.has(fact.kind))
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
			`it left ${object.kind} behind, ${object.schema_name}.${object.name}: a plugin migration leaves no function, trigger or rule anywhere, so an extension that installs one cannot be created here either`,
		);
	}
}

/**
 * The row-level half, as the difference between two readings, because the counters are the
 * backend's pending totals rather than this transaction's alone (E-664). A read is measured beside
 * a write: a plugin that may not write a core table may not copy one into a table of its own
 * either, and a view was one way of doing that (E-903). Its own tables and nothing else — the
 * allowance for the tables a foreign key of its own points at was granted for the sake of the
 * constraint check and bought a complete copy of the table instead, and no counter here separates
 * the two (E-908).
 */
function assertNoForeignTableWasReachedByARow(
	migration: OwnedMigration,
	before: WriteCounters,
	after: WriteCounters,
	declared: ReadonlySet<string>,
): void {
	const none: TableCounters = { written: 0, scanned: 0 };
	for (const [table, counters] of after) {
		const previously = before.get(table) ?? none;
		if (isOwnedTable(table, declared)) {
			continue;
		}
		if (counters.written > previously.written) {
			refuseOwned(
				"migration_wrote_a_foreign_table",
				migration,
				`it wrote rows in ${table}, and a plugin migration writes its own tables only`,
			);
		}
		if (counters.scanned > previously.scanned) {
			refuseOwned(
				"migration_read_a_foreign_table",
				migration,
				`it read rows of ${table}, and a plugin migration reads its own tables only: declaring a foreign key needs no read, and a row referencing an account is written after migrate() rather than inside it`,
			);
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
	declaredTables: readonly string[],
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
		const objectsBefore = await readSchemaObjects(tx, schema);
		const ownBefore = await readObjectsOfTheDeclaredTables(tx, schema, declaredTables);
		await applyStatements(tx, schema, migration);
		// The ownership of what it touched is read first, so a relation it should not have made is
		// refused for what it is rather than for the scan that making it recorded.
		const after = await readRelations(tx, schema);
		const own = await readObjectsOfTheDeclaredTables(tx, schema, declaredTables);
		assertEveryRelationItTouchedIsItsOwn(migration, schema, before, await readRelationsTouched(tx));
		assertItLeftEveryOtherObjectAsItFoundIt(
			migration,
			objectsBefore,
			await readSchemaObjects(tx, schema),
			new Set([...ownBefore, ...own]),
		);
		assertTheTablesThatAppearedAreTheDeclaredOnes(migration, before, after);
		assertNoCodeWasLeftBehind(migration, await tx.query<CodeRow>(CODE_THIS_TRANSACTION_LEFT, []));
		assertEveryObjectItCreatedBelongsToItsOwnTables(
			migration,
			await tx.query<DependencyRow>(OBJECTS_THIS_TRANSACTION_CREATED, []),
			own,
		);
		assertNoForeignTableWasReachedByARow(
			migration,
			writtenBefore,
			await readWriteCounters(tx, migration),
			new Set(declaredTables.map((table) => `${schema}.${table}`)),
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
	// Every table the plugin declares, across all of its migrations, because migration five may alter
	// what migration one created and the snapshot has to know that table is its own (E-918).
	const declaredByOwner = new Map<string, string[]>();
	for (const migration of owned) {
		const declared = declaredByOwner.get(migration.owner) ?? [];
		declared.push(...migration.createsTables);
		declaredByOwner.set(migration.owner, declared);
	}
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

	if (owned.length > 0) {
		await assertTheRoleCannotOutrunTheMeasurement(options.driver);
	}

	// The core schema is what a plugin's tables reference, so every core migration is applied first.
	for (const migration of owned) {
		await applyOwnedMigration(
			options.driver,
			schema,
			migration,
			declaredByOwner.get(migration.owner) ?? [],
		);
	}

	const versions = (await readLedger(options.driver, schema)).map((row) => row.version);
	return {
		appliedVersions,
		currentVersion: versions.length === 0 ? 0 : Math.max(...versions),
	};
}
