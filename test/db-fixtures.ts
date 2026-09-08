import { randomBytes, randomUUID } from "node:crypto";
import { type Actor, actorOfResolvedSession, type ResolvedSession } from "../src/core/db/actor.js";
import type { Driver } from "../src/core/db/driver.js";
import { runMigrations } from "../src/core/db/migration-runner.js";
import type { IdentityMode } from "../src/core/db/migrations/identity-mode.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

export interface MigratedSchema {
	readonly connection: TestConnection;
	readonly schema: string;
}

export function uniqueSchemaName(prefix: string): string {
	return `${prefix}_${randomBytes(6).toString("hex")}`;
}

export async function openMigratedSchema(
	prefix: string,
	identityMode: IdentityMode = "email",
): Promise<MigratedSchema> {
	const connection = await openTestConnection();
	const schema = uniqueSchemaName(prefix);
	await runMigrations({ driver: connection, schema, migrations: coreMigrations(identityMode) });
	return { connection, schema };
}

export async function dropSchema(connection: TestConnection, schema: string): Promise<void> {
	await connection.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, []);
}

export interface ColumnFact {
	readonly table: string;
	readonly column: string;
	readonly type: string;
	readonly notNull: boolean;
	readonly hasDefault: boolean;
}

export async function readColumns(driver: Driver, schema: string): Promise<ColumnFact[]> {
	const rows = await driver.query<{
		table_name: string;
		column_name: string;
		column_type: string;
		not_null: boolean;
		has_default: boolean;
	}>(
		`SELECT child.relname AS table_name,
		        column_.attname AS column_name,
		        format_type(column_.atttypid, column_.atttypmod) AS column_type,
		        column_.attnotnull AS not_null,
		        (default_.adbin IS NOT NULL) AS has_default
		 FROM pg_class child
		 JOIN pg_namespace namespace_ ON namespace_.oid = child.relnamespace
		 JOIN pg_attribute column_ ON column_.attrelid = child.oid
		   AND column_.attnum > 0 AND NOT column_.attisdropped
		 LEFT JOIN pg_attrdef default_ ON default_.adrelid = child.oid
		   AND default_.adnum = column_.attnum
		 WHERE namespace_.nspname = $1 AND child.relkind = 'r'
		 ORDER BY child.relname, column_.attname`,
		[schema],
	);
	return rows.map((row) => ({
		table: row.table_name,
		column: row.column_name,
		type: row.column_type,
		notNull: row.not_null,
		hasDefault: row.has_default,
	}));
}

export interface UserOwnedTable {
	readonly table: string;
	readonly ownerColumn: string;
}

export async function readUserOwnedTables(
	driver: Driver,
	schema: string,
): Promise<UserOwnedTable[]> {
	const rows = await driver.query<{ table_name: string; column_name: string }>(
		`SELECT DISTINCT child.relname AS table_name, column_.attname AS column_name
		 FROM pg_constraint constraint_
		 JOIN pg_class child ON child.oid = constraint_.conrelid
		 JOIN pg_namespace namespace_ ON namespace_.oid = child.relnamespace
		 JOIN pg_attribute column_ ON column_.attrelid = child.oid
		   AND column_.attnum = ANY (constraint_.conkey)
		 WHERE namespace_.nspname = $1
		   AND constraint_.contype = 'f'
		   AND constraint_.confrelid = to_regclass($2)::oid
		 ORDER BY child.relname`,
		[schema, `${schema}.user`],
	);
	return rows.map((row) => ({ table: row.table_name, ownerColumn: row.column_name }));
}

function sampleValueFor(type: string): unknown {
	switch (type) {
		case "uuid":
			return randomUUID();
		case "bytea":
			return randomBytes(32);
		case "text":
			return randomBytes(8).toString("hex");
		case "text[]":
			return "{}";
		case "jsonb":
			return "{}";
		case "boolean":
			return true;
		case "integer":
		case "bigint":
			return 1;
		case "real":
			return 1;
		case "inet":
			return "192.0.2.0/24";
		case "timestamp with time zone":
			return new Date().toISOString();
		default:
			throw new Error(`the fixture builder has no sample value for ${type}`);
	}
}

export async function createUser(driver: Driver, schema: string): Promise<string> {
	const [row] = await driver.query<{ id: string }>(
		`INSERT INTO ${schema}.user (email) VALUES ($1) RETURNING id`,
		[`${randomBytes(8).toString("hex")}@example.com`],
	);
	if (row === undefined) {
		throw new Error("the user was not created");
	}
	return row.id;
}

export async function insertRowOwnedBy(
	driver: Driver,
	schema: string,
	owned: UserOwnedTable,
	userId: string,
	columns: readonly ColumnFact[],
): Promise<void> {
	const forTable = columns.filter((column) => column.table === owned.table);
	const names: string[] = [];
	const values: unknown[] = [];
	for (const column of forTable) {
		if (column.column === owned.ownerColumn) {
			names.push(column.column);
			values.push(userId);
			continue;
		}
		if (!column.notNull || column.hasDefault) {
			continue;
		}
		names.push(column.column);
		values.push(sampleValueFor(column.type));
	}
	const placeholders = names.map((_, index) => `$${index + 1}`).join(", ");
	await driver.query(
		`INSERT INTO ${schema}.${owned.table} (${names.join(", ")}) VALUES (${placeholders})`,
		values,
	);
}

export async function countRowsOwnedBy(
	driver: Driver,
	schema: string,
	owned: UserOwnedTable,
	userId: string,
): Promise<number> {
	const [row] = await driver.query<{ remaining: number }>(
		`SELECT count(*)::int AS remaining FROM ${schema}.${owned.table} WHERE ${owned.ownerColumn} = $1`,
		[userId],
	);
	return row?.remaining ?? -1;
}

/**
 * In the library only session resolution produces a `ResolvedSession` (E-93, S-OWNER-7). A test that
 * needs an actor for a user it created itself asserts that brand here, in one place, and says so.
 */
export function actorOfTestUser(userId: string): Actor {
	return actorOfResolvedSession({ userId } as ResolvedSession);
}
