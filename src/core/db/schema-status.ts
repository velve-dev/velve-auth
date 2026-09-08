import type { Driver } from "./driver.js";
import { assertSchemaName, qualifiedTableName } from "./identifier.js";
import { type AppliedMigration, type Migration, migrationChecksum } from "./migration.js";

export interface SchemaStatus {
	readonly currentVersion: number;
	readonly expectedVersion: number;
	readonly appliedVersions: readonly number[];
	readonly pendingVersions: readonly number[];
	readonly changedVersions: readonly number[];
	readonly upToDate: boolean;
}

export interface SchemaStatusOptions {
	readonly driver: Driver;
	readonly migrations: readonly Migration[];
	readonly schema?: string;
}

export class SchemaVersionMismatchError extends Error {
	readonly code = "schema_version_mismatch";
	readonly status: SchemaStatus;

	constructor(status: SchemaStatus) {
		super(
			`the database is at migration ${status.currentVersion} and this package expects ${status.expectedVersion}: ${describe(status)}`,
		);
		this.name = "SchemaVersionMismatchError";
		this.status = status;
	}
}

function describe(status: SchemaStatus): string {
	const parts: string[] = [];
	if (status.pendingVersions.length > 0) {
		parts.push(`not applied yet: ${status.pendingVersions.join(", ")}`);
	}
	if (status.changedVersions.length > 0) {
		parts.push(`applied with different SQL: ${status.changedVersions.join(", ")}`);
	}
	return parts.join("; ");
}

async function readLedgerIfPresent(
	driver: Driver,
	schema: string,
): Promise<readonly AppliedMigration[]> {
	const ledger = qualifiedTableName(schema, "schema_migration");
	const [present] = await driver.query<{ ledger: string | null }>(
		"SELECT to_regclass($1)::text AS ledger",
		[ledger],
	);
	if (present?.ledger == null) {
		return [];
	}
	return driver.query<AppliedMigration>(
		`SELECT version, name, checksum FROM ${ledger} ORDER BY version`,
		[],
	);
}

export async function readSchemaStatus(options: SchemaStatusOptions): Promise<SchemaStatus> {
	const schema = assertSchemaName(options.schema ?? "velve");
	const applied = new Map(
		(await readLedgerIfPresent(options.driver, schema)).map((row) => [row.version, row]),
	);

	const pendingVersions: number[] = [];
	const changedVersions: number[] = [];
	for (const migration of options.migrations) {
		const previously = applied.get(migration.version);
		if (previously === undefined) {
			pendingVersions.push(migration.version);
		} else if (previously.checksum !== migrationChecksum(migration)) {
			changedVersions.push(migration.version);
		}
	}

	const appliedVersions = [...applied.keys()].sort((left, right) => left - right);
	const expectedVersions = options.migrations.map((migration) => migration.version);

	return {
		currentVersion: appliedVersions.at(-1) ?? 0,
		expectedVersion: expectedVersions.length === 0 ? 0 : Math.max(...expectedVersions),
		appliedVersions,
		pendingVersions,
		changedVersions,
		upToDate: pendingVersions.length === 0 && changedVersions.length === 0,
	};
}

export async function assertSchemaUpToDate(options: SchemaStatusOptions): Promise<SchemaStatus> {
	const status = await readSchemaStatus(options);
	if (!status.upToDate) {
		throw new SchemaVersionMismatchError(status);
	}
	return status;
}
