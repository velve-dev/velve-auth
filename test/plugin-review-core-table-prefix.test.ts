import { afterAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations, coreTableNames } from "../src/core/db/migrations/index.js";
import type { VelvePlugin } from "../src/core/plugin/config.js";
import { createOwnTables } from "../src/core/plugin/own-tables.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { createUser, dropSchema, uniqueSchemaName } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

interface Reach {
	readonly id: string;
	readonly table: string;
	/**
	 * A version and a column of its own for each case. Two of these ids reach two core tables each
	 * and two of the tables are reached by two ids, so cases sharing a plugin id or a table would
	 * otherwise refuse each other — one as `migration_checksum_changed`, one as a duplicate column —
	 * and pass for a reason that has nothing to do with ownership (E-919).
	 */
	readonly version: number;
	readonly column: string;
}

/**
 * Every plugin id that carries a core table name inside its own prefix. A core table name contains
 * `_` too, so `one_time_token` begins with `one_` and `plugin_schema_migration` with `plugin_`;
 * the list is derived from the migrations rather than written out, so a core table added later is
 * covered without this file being edited.
 */
function everyIdThatPrefixesACoreTable(): readonly Reach[] {
	const reaches: Reach[] = [];
	for (const table of coreTableNames()) {
		for (const [index, character] of [...table].entries()) {
			if (character === "_" && index > 0) {
				const version = reaches.length + 1;
				reaches.push({
					id: table.slice(0, index),
					table,
					version,
					column: `taken_over_${version}`,
				});
			}
		}
	}
	return reaches;
}

const REACHES = everyIdThatPrefixesACoreTable();

let shared: TestConnection | undefined;
const schemas: string[] = [];

async function connection(): Promise<TestConnection> {
	shared ??= await openTestConnection();
	return shared;
}

async function freshSchema(): Promise<string> {
	const driver = await connection();
	const schema = uniqueSchemaName("pluginprefix");
	await runMigrations({ driver, schema, migrations: coreMigrations("email") });
	schemas.push(schema);
	return schema;
}

/**
 * One schema for the whole class. Every case below is refused and rolls back, so none of them
 * leaves a mark for the next to trip over — and a regression that let one through would leave a
 * column the case that lost it asserts the absence of.
 */
let sharedSchema: Promise<string> | undefined;

function schemaForTheClass(): Promise<string> {
	sharedSchema ??= freshSchema();
	return sharedSchema;
}

afterAll(async () => {
	sharedSchema = undefined;
	const driver = shared;
	if (driver === undefined) {
		return;
	}
	for (const schema of schemas.splice(0)) {
		await dropSchema(driver, schema);
	}
	await driver.close();
	shared = undefined;
});

async function refusalOf(schema: string, plugin: VelvePlugin): Promise<{ readonly code?: string }> {
	const driver = await connection();
	try {
		return await createVelveAuth(
			configFor({ database: driver as Driver, schema, plugins: [plugin] }),
		)
			.migrate()
			.then(() => ({}))
			.catch((error: { code?: string }) => error);
	} catch (error) {
		return error as { code?: string };
	}
}

function reachingMigration(reach: Reach): VelvePlugin {
	return {
		id: reach.id,
		migrations: [
			{
				version: reach.version,
				name: "reach_the_core_table",
				createsTables: [],
				sql: `ALTER TABLE velve.${reach.table} ADD COLUMN ${reach.column} integer`,
			},
		],
	} as unknown as VelvePlugin;
}

describe("a plugin id that prefixes a core table name does not own that table (3.11)", () => {
	it("derives at least one such id from the core migrations, so the cases below are not empty", () => {
		expect(REACHES.length).toBeGreaterThan(0);
		expect(REACHES.map((reach) => reach.id)).toContain("one");
	});

	it.each(REACHES)("refuses plugin $id the core table $table", async (reach) => {
		const schema = await schemaForTheClass();

		const refusal = await refusalOf(schema, reachingMigration(reach));

		expect(refusal.code).toBeDefined();
		expect(refusal.code).not.toBe("migration_checksum_changed");
		const columns = await (await connection()).query<{ present: number }>(
			`SELECT 1 AS present FROM pg_attribute column_
			 JOIN pg_class child ON child.oid = column_.attrelid
			 JOIN pg_namespace namespace_ ON namespace_.oid = child.relnamespace
			 WHERE namespace_.nspname = $1 AND child.relname = $2 AND column_.attname = $3`,
			[schema, reach.table, reach.column],
		);
		expect(columns).toStrictEqual([]);
	});

	/**
	 * The whole class, in the one instance that ends in an account takeover: a chosen password-reset
	 * token against a chosen user, written by a plugin whose id is a prefix of `one_time_token`.
	 */
	it("refuses a plugin called one the password reset token it wrote for a chosen account", async () => {
		const schema = await freshSchema();
		const driver = await connection();
		const victim = await createUser(driver, schema);

		const refusal = await refusalOf(schema, {
			id: "one",
			migrations: [
				{
					version: 1,
					name: "mint_a_reset_token",
					createsTables: [],
					sql: `INSERT INTO velve.one_time_token (token_sha256, purpose, user_id, expires_at)
						VALUES (decode('deadbeef', 'hex'), 'password_reset', '${victim}', now() + interval '1 day')`,
				},
			],
		} as unknown as VelvePlugin);

		// The insert writes the token and its foreign key reads the account, and the counters are
		// walked in the order the statistics view answers in, so either refusal is the right one.
		expect(["migration_wrote_a_foreign_table", "migration_read_a_foreign_table"]).toContain(
			refusal.code,
		);
		expect(await driver.query(`SELECT 1 FROM ${schema}.one_time_token`, [])).toStrictEqual([]);
	});

	/**
	 * The two boundaries answer the same question, so neither can widen without the other: the
	 * reference already states that `ownTables.query` refuses `velve.plugin_schema_migration` even
	 * to a plugin called `plugin`, and the runner said the opposite.
	 */
	it.each(REACHES)(
		"refuses plugin $id the table $table through ownTables.query as well",
		({ id, table }) => {
			const ownTables = createOwnTables({
				driver: {
					query: () => Promise.reject(new Error("no statement may reach the driver")),
				} as unknown as Driver,
				schema: "velve",
				pluginId: id,
			});

			return expect(ownTables.query(`SELECT 1 FROM velve.${table}`, [])).rejects.toMatchObject({
				code: "plugin_table_not_its_own",
			});
		},
	);
});
