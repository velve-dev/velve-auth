import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import type { VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import {
	asJavaScriptPlugin,
	asTheMigrationRole,
	createTheMigrationRole,
	dropTheMigrationRole,
	type MigrationRole,
} from "./plugin-fixtures.js";

interface Opened {
	readonly connection: TestConnection;
	readonly schema: string;
	migrate(plugins: readonly VelvePlugin[]): Promise<{ readonly code?: string }>;
}

const opened: Opened[] = [];
const roles: MigrationRole[] = [];
const strayTables: string[] = [];

async function openSchema(): Promise<Opened> {
	const { connection, schema } = await openMigratedSchema("pluginboundary");
	const role = await createTheMigrationRole(connection, schema);
	roles.push(role);
	const instance: Opened = {
		connection,
		schema,
		migrate: (plugins) =>
			asTheMigrationRole(role, (roleDriver) =>
				createVelveAuth(configFor({ database: roleDriver as Driver, schema, plugins }))
					.migrate()
					.then(() => ({}))
					.catch((error: { code?: string }) => error),
			),
	};
	opened.push(instance);
	return instance;
}

afterEach(async () => {
	for (const instance of opened.splice(0)) {
		for (const table of strayTables.splice(0)) {
			await instance.connection.query(`DROP TABLE IF EXISTS public.${table}`, []);
		}
		await dropSchema(instance.connection, instance.schema);
		for (const used of roles.splice(0)) {
			await dropTheMigrationRole(instance.connection, used);
		}
		await instance.connection.close();
	}
});

async function tableExistsInPublic(instance: Opened, table: string): Promise<boolean> {
	const rows = await instance.connection.query<{ present: number }>(
		`SELECT 1 AS present FROM pg_class child
		 JOIN pg_namespace namespace_ ON namespace_.oid = child.relnamespace
		 WHERE namespace_.nspname = 'public' AND child.relname = $1`,
		[table],
	);
	return rows.length > 0;
}

/**
 * 3.11 lets a plugin create its own tables **in the schema `velve`**. The runner measures the
 * configured schema alone, so a statement naming another schema is measured nowhere.
 */
describe("what a plugin migration may create outside the configured schema (3.11)", () => {
	it("refuses a migration that creates a table in another schema beside the one it declares", async () => {
		const instance = await openSchema();
		const stray = `audit_reach_${randomBytes(4).toString("hex")}`;
		strayTables.push(stray);

		const refusal = await instance.migrate([
			{
				id: "audit",
				migrations: [
					{
						version: 1,
						name: "reach_out_of_the_schema",
						createsTables: ["audit_entry"],
						sql: `CREATE TABLE velve.audit_entry (id uuid PRIMARY KEY);
							CREATE TABLE public.${stray} (id uuid PRIMARY KEY);`,
					},
				],
			} satisfies VelvePlugin<"audit">,
		]);

		expect(await tableExistsInPublic(instance, stray)).toBe(false);
		expect(refusal.code).toMatch(/^migration_/);
	});

	it("refuses a migration that declares nothing and creates a table in another schema", async () => {
		const instance = await openSchema();
		const stray = `audit_reach_${randomBytes(4).toString("hex")}`;
		strayTables.push(stray);

		const refusal = await instance.migrate([
			asJavaScriptPlugin({
				id: "audit",
				migrations: [
					{
						version: 1,
						name: "declare_nothing_create_elsewhere",
						createsTables: [],
						sql: `CREATE TABLE public.${stray} (id uuid PRIMARY KEY);`,
					},
				],
			}),
		]);

		expect(await tableExistsInPublic(instance, stray)).toBe(false);
		expect(refusal.code).toMatch(/^migration_/);
	});
});

/**
 * 3.11, in its list of what a plugin may not do: write core tables directly. Only repository
 * methods, and each demands an actor. A migration is plugin-supplied SQL and is on the same list.
 */
describe("what a plugin migration may write in a core table (3.11)", () => {
	it("refuses a migration that updates a row of velve.user", async () => {
		const instance = await openSchema();
		const userId = await createUser(instance.connection, instance.schema);

		const refusal = await instance.migrate([
			asJavaScriptPlugin({
				id: "audit",
				migrations: [
					{
						version: 1,
						name: "disable_every_account",
						createsTables: [],
						sql: "UPDATE velve.user SET disabled_at = now();",
					},
				],
			}),
		]);

		const [row] = await instance.connection.query<{ disabled_at: unknown }>(
			`SELECT disabled_at FROM ${instance.schema}.user WHERE id = $1`,
			[userId],
		);

		expect(row?.disabled_at).toBeNull();
		expect(refusal.code).toMatch(/^migration_/);
	});
});
