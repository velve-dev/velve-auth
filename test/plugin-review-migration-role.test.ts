import { afterAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import type { VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { createUser, dropSchema, uniqueSchemaName } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import {
	asTheMigrationRole,
	createTheMigrationRole,
	dropTheMigrationRole,
	type MigrationRole,
} from "./plugin-fixtures.js";

let shared: TestConnection | undefined;
const schemas: string[] = [];
const roles: MigrationRole[] = [];
const holders: string[] = [];
let current: MigrationRole | undefined;

function theRole(): MigrationRole {
	if (current === undefined) {
		throw new Error("no migration role was created for this schema");
	}
	return current;
}

async function connection(): Promise<TestConnection> {
	shared ??= await openTestConnection();
	return shared;
}

async function freshSchema(): Promise<string> {
	const driver = await connection();
	const schema = uniqueSchemaName("pluginrole");
	await runMigrations({ driver, schema, migrations: coreMigrations("email") });
	current = await createTheMigrationRole(driver, schema);
	roles.push(current);
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
	for (const used of roles.splice(0)) {
		await dropTheMigrationRole(driver, used);
	}
	await driver.query("DROP SCHEMA IF EXISTS p_outside CASCADE", []).catch(() => undefined);
	await driver.query("DROP ROLE IF EXISTS p_backdoor", []).catch(() => undefined);
	await driver
		.query("DROP FUNCTION IF EXISTS public.p_delegated_write(uuid)", [])
		.catch(() => undefined);
	for (const holder of holders.splice(0)) {
		await driver.query(`DROP OWNED BY ${holder} CASCADE`, []).catch(() => undefined);
		await driver.query(`DROP ROLE IF EXISTS ${holder}`, []).catch(() => undefined);
	}
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
	const attempt = async (on: Driver) => {
		try {
			return await createVelveAuth(configFor({ database: on, schema, plugins: [plugin] }))
				.migrate()
				.then(() => ({}))
				.catch((error: { code?: string; message?: string }) => error);
		} catch (error) {
			return error as { code?: string; message?: string };
		}
	};
	return underTheRole
		? asTheMigrationRole(theRole(), (roleDriver) => attempt(roleDriver as Driver))
		: attempt(driver as Driver);
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
	// The complaint is the server's own and its wording is the server's to change: PostgreSQL 14
	// answers "must be superuser to create superusers" where 16 and newer answer "permission
	// denied to create role", both refusing, and the alternation is what makes the case a
	// statement about the refusal rather than about a release (E-1503).
	it.each<[string, string | RegExp]>([
		[
			"CREATE ROLE p_backdoor LOGIN SUPERUSER",
			/permission denied to create role|must be superuser to create superusers/,
		],
		["CREATE CAST (text AS integer) WITH INOUT AS IMPLICIT", "must be owner of type"],
		["SET LOCAL track_counts = off; SELECT 1; SET LOCAL track_counts = on", "track_counts"],
	])("refuses %s", async (sql, complaint) => {
		const schema = await freshSchema();

		const outcome = await outcomeOf(schema, migrationOf(sql), true);

		expect(outcome.message ?? "").toMatch(complaint);
	});

	it.each([["CREATE SCHEMA p_outside"], ["ALTER ROLE CURRENT_USER SET search_path = velve"]])(
		"still accepts %s, which the role restriction does not reach",
		async (sql) => {
			const schema = await freshSchema();

			const outcome = await outcomeOf(schema, migrationOf(sql), true);

			expect(outcome.code).toBeUndefined();
		},
	);
});

/** PostgreSQL 15 and newer. Before that there is no parameter ACL, so the grant cannot be made. */
async function serverRecordsParameterGrants(driver: TestConnection): Promise<boolean> {
	const [row] = await driver.query<{ recorded: boolean }>(
		"SELECT to_regprocedure('pg_catalog.has_parameter_privilege(name, text, text)') IS NOT NULL AS recorded",
		[],
	);
	return row?.recorded === true;
}

/**
 * `GRANT SET ON PARAMETER track_counts` reaches the capability `rolsuper` reaches and moves neither
 * role attribute, so the two columns the guard read first answered `false` for a connection that
 * could switch the row half off around its own statements (E-1006). A `NOINHERIT` member of a role
 * holding that grant answers `false` again to the question the guard asked second, and `true` to the
 * one it asked first, which is the asymmetry E-1011 closed. The last case holds the same capability
 * by a route no catalogue the guard reads records, and is green on purpose — with the control beside
 * it that says why it is green.
 */
describe("a capability that is not a role attribute (3.11)", () => {
	it("refuses a migration role granted SET on the parameter track_counts", async () => {
		const schema = await freshSchema();
		const owner = await connection();
		const victim = await createUser(owner, schema, { email: "victim@example.com" });
		const recorded = await serverRecordsParameterGrants(owner);
		if (recorded) {
			await owner.query(`GRANT SET ON PARAMETER track_counts TO ${theRole().name}`, []);
		}

		const outcome = await outcomeOf(
			schema,
			migrationOf(
				`SET LOCAL track_counts = off;
				UPDATE velve.user SET email = 'attacker@example.com' WHERE id = '${victim}';
				SET LOCAL track_counts = on`,
			),
			true,
		);

		expect(outcome.code).toBe(recorded ? "migration_role_unbounded" : undefined);
		if (recorded) {
			expect(outcome.message).toContain("track_counts");
		}
		const rows = await owner.query<{ email: string }>(
			`SELECT email FROM ${schema}.user WHERE id = $1`,
			[victim],
		);
		expect(rows[0]?.email).toBe("victim@example.com");
	});

	it("refuses a role that may SET ROLE to a holder of the grant without inheriting it", async () => {
		const schema = await freshSchema();
		const owner = await connection();
		const victim = await createUser(owner, schema, { email: "victim@example.com" });
		const recorded = await serverRecordsParameterGrants(owner);
		const holder = `${schema}_holder`;
		await owner.query(`CREATE ROLE ${holder}`, []);
		holders.push(holder);
		await owner.query(`ALTER ROLE ${theRole().name} NOINHERIT`, []);
		await owner.query(`GRANT ${holder} TO ${theRole().name}`, []);
		if (recorded) {
			await owner.query(`GRANT SET ON PARAMETER track_counts TO ${holder}`, []);
		}

		const outcome = await outcomeOf(
			schema,
			migrationOf(
				`SET ROLE ${holder};
				SET LOCAL track_counts = off;
				RESET ROLE;
				UPDATE velve.user SET email = 'attacker@example.com' WHERE id = '${victim}';
				SET ROLE ${holder};
				SET LOCAL track_counts = on;
				RESET ROLE`,
			),
			true,
		);

		// Where the server records no parameter grant the holder cannot hold one, so PostgreSQL
		// refuses `SET LOCAL track_counts` under it and there is nothing here for the guard to catch.
		expect(outcome.code ?? outcome.message).toBeDefined();
		if (recorded) {
			expect(outcome.code).toBe("migration_role_unbounded");
			expect(outcome.message).toContain("track_counts");
		}
		const rows = await owner.query<{ email: string }>(
			`SELECT email FROM ${schema}.user WHERE id = $1`,
			[victim],
		);
		expect(rows[0]?.email).toBe("victim@example.com");
	});

	/**
	 * The pair is the case. Alone, the accepted one is green whether the delegated write defeated the
	 * measurements or was never seen by them; the control switches nothing off and is refused by the
	 * foreign-table measurement, so the first case is green **because** the counters were off.
	 */
	it.each([
		[true, undefined, "attacker@example.com"],
		[false, "migration_wrote_a_foreign_table", "victim@example.com"],
	])(
		"accepts a delegated write that switches the counters (%s) and refuses one that does not",
		async (switchTheCounters, expected, address) => {
			const schema = await freshSchema();
			const owner = await connection();
			const victim = await createUser(owner, schema, { email: "victim@example.com" });
			const switching = switchTheCounters ? `PERFORM set_config('track_counts', 'off', true);` : "";
			const restoring = switchTheCounters ? `PERFORM set_config('track_counts', 'on', true);` : "";
			await owner.query(
				`CREATE OR REPLACE FUNCTION public.p_delegated_write(target uuid) RETURNS void
				LANGUAGE plpgsql SECURITY DEFINER AS $delegated$
				BEGIN
					${switching}
					EXECUTE format('UPDATE %I.user SET email = $1 WHERE id = $2', '${schema}')
						USING 'attacker@example.com', target;
					${restoring}
				END
				$delegated$`,
				[],
			);
			await owner.query(
				`GRANT EXECUTE ON FUNCTION public.p_delegated_write(uuid) TO ${theRole().name}`,
				[],
			);

			const outcome = await outcomeOf(
				schema,
				migrationOf(`SELECT public.p_delegated_write('${victim}')`),
				true,
			);

			expect(outcome.code).toBe(expected);
			const rows = await owner.query<{ email: string }>(
				`SELECT email FROM ${schema}.user WHERE id = $1`,
				[victim],
			);
			// The address, not the outcome code: a refusal after the write would roll it back, so only
			// reading `velve.user` says whether the delegated write survived (E-1012).
			expect(rows[0]?.email).toBe(address);
		},
	);
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

		// Under a connection that is the role, the refusal comes from PostgreSQL rather than from the
		// runner: `RESET ROLE` reaches `session_user`, which is the role itself and not a superuser.
		expect(outcome.code ?? outcome.message).toBeDefined();
		const rows = await driver.query<{ email: string }>(
			`SELECT email FROM ${schema}.user WHERE id = $1`,
			[victim],
		);
		expect(rows[0]?.email).toBe("victim@example.com");
	});

	/**
	 * The runner re-reads the connection for every migration rather than once for the run. That is
	 * not independently observable from outside — nothing a migration can do changes which roles the
	 * connection reaches once `session_user` is read — so what this asserts is the outcome, and the
	 * re-check is defence for a configuration these tests cannot construct (E-929).
	 */
	it("leaves the second plugin bound after the first has reset its role", async () => {
		const schema = await freshSchema();

		const outcome = await asTheMigrationRole(theRole(), (driver) =>
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
				.then(() => ({}) as { code?: string; message?: string })
				.catch((error: { code?: string; message?: string }) => error),
		);

		expect(outcome.code ?? outcome.message).toBeDefined();
		const applied = await (await connection()).query<{ plugin_id: string }>(
			`SELECT plugin_id FROM ${schema}.plugin_schema_migration`,
			[],
		);
		expect(applied.map((row) => row.plugin_id)).toStrictEqual(["first"]);
	});
});
