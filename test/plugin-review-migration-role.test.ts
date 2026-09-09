import { afterAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import type { VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { createUser, dropSchema, uniqueSchemaName } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { asMigrationRole, grantTheMigrationRole } from "./plugin-fixtures.js";

let shared: TestConnection | undefined;
const schemas: string[] = [];

async function connection(): Promise<TestConnection> {
	shared ??= await openTestConnection();
	return shared;
}

async function freshSchema(): Promise<string> {
	const driver = await connection();
	const schema = uniqueSchemaName("pluginrole");
	await runMigrations({ driver, schema, migrations: coreMigrations("email") });
	await grantTheMigrationRole(driver, schema);
	schemas.push(schema);
	return schema;
}

afterAll(async () => {
	const driver = shared;
	if (driver === undefined) {
		return;
	}
	await driver.query("RESET ROLE", []).catch(() => undefined);
	for (const schema of schemas.splice(0)) {
		await dropSchema(driver, schema);
	}
	await driver.query("DROP SCHEMA IF EXISTS p_outside CASCADE", []).catch(() => undefined);
	await driver.query("DROP ROLE IF EXISTS p_backdoor", []).catch(() => undefined);
	await driver
		.query("ALTER ROLE velve_plugin_migrator RESET search_path", [])
		.catch(() => undefined);
	await driver.close();
	shared = undefined;
});

function migrationOf(sql: string): VelvePlugin {
	return {
		id: "audit",
		migrations: [{ version: 1, name: "reach", createsTables: [], sql }],
	} as unknown as VelvePlugin;
}

async function outcomeOf(
	schema: string,
	plugin: VelvePlugin,
	underTheRole: boolean,
): Promise<{ readonly code?: string; readonly message?: string }> {
	const driver = await connection();
	const attempt = async () => {
		try {
			return await createVelveAuth(
				configFor({ database: driver as Driver, schema, plugins: [plugin] }),
			)
				.migrate()
				.then(() => ({}))
				.catch((error: { code?: string; message?: string }) => error);
		} catch (error) {
			return error as { code?: string; message?: string };
		}
	};
	return underTheRole ? asMigrationRole(driver, attempt) : attempt();
}

/**
 * Every measurement in the runner is a superuser's to switch off, so the connection a plugin
 * migration runs on is itself part of the boundary. The library cannot check that a restricted role
 * was provisioned — a role that was never created looks exactly like one that was not needed — but
 * it can refuse a role too powerful for anything it measures to bind, and then a missing provision
 * is a refusal (E-920).
 */
describe("the connection a plugin migration runs on (3.11)", () => {
	it("refuses a plugin migration on a superuser connection", async () => {
		const schema = await freshSchema();

		const outcome = await outcomeOf(schema, migrationOf("SELECT 1"), false);

		expect(outcome.code).toBe("migration_role_unbounded");
		expect(outcome.message).toContain("superuser");
	});

	it("runs the ordinary plugin table on a connection that is neither", async () => {
		const schema = await freshSchema();

		const outcome = await outcomeOf(
			schema,
			{
				id: "audit",
				migrations: [
					{
						version: 1,
						name: "create",
						createsTables: ["audit_entry"],
						sql: `CREATE TABLE velve.audit_entry (
							id uuid PRIMARY KEY,
							user_id uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE);`,
					},
				],
			} as unknown as VelvePlugin,
			true,
		);

		expect(outcome.code).toBeUndefined();
	});

	it("applies core migrations on the same superuser connection, because only plugins are refused", async () => {
		const driver = await connection();
		const schema = uniqueSchemaName("pluginrolecore");
		schemas.push(schema);

		await expect(
			runMigrations({ driver, schema, migrations: coreMigrations("email") }),
		).resolves.toBeDefined();
	});
});

/**
 * What the refusal buys, measured rather than argued: under a role that is neither a superuser nor
 * a creator of roles, PostgreSQL itself refuses the three statements that outran every measurement
 * here. The other two survive, and the entry says so rather than the reference implying otherwise.
 */
describe("what the restricted role closes and what it does not (3.11)", () => {
	it.each([
		["CREATE ROLE p_backdoor LOGIN SUPERUSER", "create role"],
		["CREATE CAST (text AS integer) WITH INOUT AS IMPLICIT", "must be owner of type"],
		["SET LOCAL track_counts = off; SELECT 1; SET LOCAL track_counts = on", "track_counts"],
	])("refuses %s", async (sql, complaint) => {
		const schema = await freshSchema();

		const outcome = await outcomeOf(schema, migrationOf(sql), true);

		expect(outcome.message ?? "").toContain(complaint);
	});

	it.each([
		["CREATE SCHEMA p_outside"],
		["ALTER ROLE velve_plugin_migrator SET search_path = velve"],
	])("still accepts %s, which the role restriction does not reach", async (sql) => {
		const schema = await freshSchema();

		const outcome = await outcomeOf(schema, migrationOf(sql), true);

		expect(outcome.code).toBeUndefined();
	});
});

/**
 * `SET ROLE` changes `current_user` and leaves `session_user` alone, and `RESET ROLE` puts it back.
 * A guard that reads `current_user` alone is therefore one statement from being undone — and a test
 * harness that reaches the restricted role by `SET ROLE` from a superuser connection is exactly the
 * configuration in which the guard cannot be observed to work at all (E-929).
 */
describe("a migration that resets the role it was checked under (3.11)", () => {
	it("refuses a migration that resets the role and rewrites an address", async () => {
		const schema = await freshSchema();
		const driver = await connection();
		const victim = await createUser(driver, schema, { email: "victim@example.com" });

		const outcome = await outcomeOf(
			schema,
			migrationOf(
				`RESET ROLE;
				SET LOCAL track_counts = off;
				UPDATE velve.user SET email = 'attacker@example.com' WHERE id = '${victim}';
				SET LOCAL track_counts = on`,
			),
			true,
		);

		expect(outcome.code).toBeDefined();
		const rows = await driver.query<{ email: string }>(
			`SELECT email FROM ${schema}.user WHERE id = $1`,
			[victim],
		);
		expect(rows[0]?.email).toBe("victim@example.com");
	});

	it("checks the connection again for the second plugin, not once for the run", async () => {
		const schema = await freshSchema();
		const driver = await connection();

		const outcome = await asMigrationRole(driver, () =>
			createVelveAuth(
				configFor({
					database: driver as Driver,
					schema,
					plugins: [
						{
							id: "first",
							migrations: [{ version: 1, name: "escape", createsTables: [], sql: "RESET ROLE" }],
						} as unknown as VelvePlugin,
						{
							id: "second",
							migrations: [
								{
									version: 1,
									name: "reach",
									createsTables: [],
									sql: `SET LOCAL track_counts = off;
										DELETE FROM velve.session;
										SET LOCAL track_counts = on`,
								},
							],
						} as unknown as VelvePlugin,
					],
				}),
			)
				.migrate()
				.then(() => ({}) as { code?: string })
				.catch((error: { code?: string }) => error),
		);

		expect(outcome.code).toBeDefined();
	});
});
