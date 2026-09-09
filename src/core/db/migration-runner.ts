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

const COLUMNS_OF_EVERY_TABLE = `
SELECT child.relname AS table_name,
       column_.attname AS column_name,
       format_type(column_.atttypid, column_.atttypmod) AS column_type,
       column_.attnotnull AS not_null
FROM pg_class child
JOIN pg_namespace namespace_ ON namespace_.oid = child.relnamespace
JOIN pg_attribute column_ ON column_.attrelid = child.oid
  AND column_.attnum > 0 AND NOT column_.attisdropped
WHERE namespace_.nspname = $1 AND child.relkind IN ('r', 'p')
ORDER BY child.relname, column_.attname`;

type MigrationRefusalCode =
	| "migration_duplicate_version"
	| "migration_checksum_changed"
	| "migration_table_undeclared"
	| "migration_table_unprefixed"
	| "migration_foreign_table_changed";

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

interface ColumnRow {
	readonly table_name: string;
	readonly column_name: string;
	readonly column_type: string;
	readonly not_null: boolean;
}

/** Every table of the schema with the shape of its columns, so one comparison answers whether a
 * table appeared, went, or grew a column. */
type SchemaShape = ReadonlyMap<string, string>;

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

async function readSchemaShape(tx: Driver, schema: string): Promise<SchemaShape> {
	const shape = new Map<string, string>();
	for (const row of await tx.query<ColumnRow>(COLUMNS_OF_EVERY_TABLE, [schema])) {
		const column = `${row.column_name} ${row.column_type}${row.not_null ? " NOT NULL" : ""}`;
		shape.set(row.table_name, `${shape.get(row.table_name) ?? ""}${column}, `);
	}
	return shape;
}

function refuseOwned(code: MigrationRefusalCode, migration: OwnedMigration, what: string): never {
	throw new MigrationRefusedError(
		code,
		`refusing migration ${migration.version} "${migration.name}" of plugin ${migration.owner}: ${what}`,
	);
}

/**
 * The tables a migration created are measured rather than read out of its SQL, so a statement the
 * runner cannot parse cannot smuggle a table past the declaration either (E-637).
 */
function assertOnlyTheDeclaredTablesAppeared(
	migration: OwnedMigration,
	before: SchemaShape,
	after: SchemaShape,
): void {
	const created = [...after.keys()].filter((table) => !before.has(table)).sort();
	const removed = [...before.keys()].filter((table) => !after.has(table)).sort();
	const declared = [...new Set(migration.createsTables)].sort();

	if (removed.length > 0) {
		refuseOwned("migration_foreign_table_changed", migration, `it removed ${removed.join(", ")}`);
	}
	for (const table of created) {
		if (!table.startsWith(`${migration.owner}_`)) {
			refuseOwned(
				"migration_table_unprefixed",
				migration,
				`it created ${table}, which does not carry the prefix ${migration.owner}_`,
			);
		}
	}
	if (created.join(",") !== declared.join(",")) {
		refuseOwned(
			"migration_table_undeclared",
			migration,
			`it declares [${declared.join(", ")}] and created [${created.join(", ")}]`,
		);
	}
	for (const [table, columns] of before) {
		if (after.get(table) !== columns) {
			refuseOwned(
				"migration_foreign_table_changed",
				migration,
				`it changed the columns of ${table}`,
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

		const before = await readSchemaShape(tx, schema);
		await applyStatements(tx, schema, migration);
		assertOnlyTheDeclaredTablesAppeared(migration, before, await readSchemaShape(tx, schema));
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
