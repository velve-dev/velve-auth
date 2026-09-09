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
				reaches.push({ id: table.slice(0, index), table });
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

afterAll(async () => {
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

function reachingMigration(id: string, table: string): VelvePlugin {
	return {
		id,
		migrations: [
			{
				version: 1,
				name: "reach_the_core_table",
				createsTables: [],
				sql: `ALTER TABLE velve.${table} ADD COLUMN taken_over integer`,
			},
		],
	} as unknown as VelvePlugin;
}

describe("a plugin id that prefixes a core table name does not own that table (3.11)", () => {
	it("derives at least one such id from the core migrations, so the cases below are not empty", () => {
		expect(REACHES.length).toBeGreaterThan(0);
		expect(REACHES.map((reach) => reach.id)).toContain("one");
	});

	it.each(REACHES)("refuses plugin $id the core table $table", async ({ id, table }) => {
		const schema = await freshSchema();

		const refusal = await refusalOf(schema, reachingMigration(id, table));

		expect(refusal.code).toBeDefined();
		const columns = await (await connection()).query<{ present: number }>(
			`SELECT 1 AS present FROM pg_attribute column_
			 JOIN pg_class child ON child.oid = column_.attrelid
			 JOIN pg_namespace namespace_ ON namespace_.oid = child.relnamespace
			 WHERE namespace_.nspname = $1 AND child.relname = $2 AND column_.attname = 'taken_over'`,
			[schema, table],
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

		expect(refusal.code).toBe("migration_wrote_a_foreign_table");
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
