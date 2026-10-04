import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import type { FrozenContext, VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth, type VelveAuth, type VelveAuthConfig } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { dropSchema, uniqueSchemaName } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import {
	createAPluginLoginRole,
	createContextProbe,
	createTheMigrationRole,
	dropAPluginLoginRole,
	dropTheMigrationRole,
	type MigrationRole,
	type PluginLoginRole,
} from "./plugin-fixtures.js";

/**
 * S-OWNER-10 with `pluginDatabase`, read from the side of the login rather than from the library:
 * every way an operator's grant can hand the plugin login a core row must refuse `migrate()`, and a
 * pass must not outlive the core tables it was measured against. Each case gives one fresh login
 * exactly one route and nothing else, so a refusal is caused by that route.
 */

const REACHES_THE_CORE = "plugin_database_reaches_the_core";

let owner: TestConnection;
let schema: string;
let migrator: MigrationRole;
let asTheLibrary: TestConnection;
const logins: PluginLoginRole[] = [];
const connections: TestConnection[] = [];
const freshSchemas: string[] = [];

function demoPlugin(within: string): VelvePlugin {
	return {
		...createContextProbe().plugin,
		migrations: [
			{
				version: 1,
				name: "entries",
				createsTables: ["demo_entry"],
				sql: `CREATE TABLE ${within}.demo_entry (
					id bigserial PRIMARY KEY,
					note text NOT NULL,
					user_id uuid REFERENCES ${within}.user(id) ON DELETE CASCADE)`,
			},
		],
	} as VelvePlugin;
}

function start(
	options: { readonly within: string; readonly library: Driver; readonly plugin: Driver },
	overrides: Partial<VelveAuthConfig<"email">> = {},
): VelveAuth<"email"> {
	return createVelveAuth(
		configFor({
			database: options.library,
			schema: options.within,
			plugins: [demoPlugin(options.within)],
			pluginDatabase: options.plugin,
			...overrides,
		}),
	);
}

function ownTablesOf(auth: VelveAuth<"email">): FrozenContext["ownTables"] {
	const route = auth.routes.find((candidate) => candidate.name === "demo.echo");
	if (route === undefined) {
		throw new Error("the demo plugin contributed no route");
	}
	return auth.http.pluginContextOf(route).ownTables;
}

async function codeOf(attempt: Promise<unknown>): Promise<string | undefined> {
	try {
		await attempt;
		return undefined;
	} catch (error) {
		return (error as { code?: string }).code ?? String(error);
	}
}

async function aLogin(suffix: string): Promise<{ role: PluginLoginRole; driver: TestConnection }> {
	const role = await createAPluginLoginRole(owner, `${schema}_${suffix}`);
	logins.push(role);
	const driver = await openTestConnection(role.url);
	connections.push(driver);
	return { role, driver };
}

beforeAll(async () => {
	owner = await openTestConnection();
	schema = uniqueSchemaName("pluginreach");
	await runMigrations({ driver: owner, schema, migrations: coreMigrations("email") });
	migrator = await createTheMigrationRole(owner, schema);
	asTheLibrary = await openTestConnection(migrator.url);
	connections.push(asTheLibrary);
}, 60_000);

afterAll(async () => {
	for (const connection of connections) {
		await connection.close();
	}
	await dropSchema(owner, schema);
	for (const fresh of freshSchemas) {
		await dropSchema(owner, fresh);
	}
	for (const role of logins) {
		await dropAPluginLoginRole(owner, role.name);
	}
	await dropTheMigrationRole(owner, migrator);
	await owner.close();
});

describe("a right on part of a core table refuses the plugin login (S-OWNER-10)", () => {
	it("refuses a login granted SELECT on one column of the user table", async () => {
		const { role, driver } = await aLogin("column_read");
		await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role.name}`, []);
		await owner.query(`GRANT SELECT (id, email) ON ${schema}.user TO ${role.name}`, []);

		await expect(driver.query(`SELECT id, email FROM ${schema}.user`, [])).resolves.toBeDefined();
		expect(
			await codeOf(start({ within: schema, library: asTheLibrary, plugin: driver }).migrate()),
		).toBe(REACHES_THE_CORE);
	});

	it("refuses a login granted UPDATE on one column of the session table", async () => {
		const { role, driver } = await aLogin("column_write");
		await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role.name}`, []);
		await owner.query(
			`GRANT UPDATE (absolute_expires_at) ON ${schema}.session TO ${role.name}`,
			[],
		);

		expect(
			await codeOf(start({ within: schema, library: asTheLibrary, plugin: driver }).migrate()),
		).toBe(REACHES_THE_CORE);
	});
});

describe("every table the core writes counts as a core table (S-OWNER-10)", () => {
	it("refuses a login granted DELETE on the core migration ledger", async () => {
		const { role, driver } = await aLogin("ledger");
		await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role.name}`, []);
		await owner.query(`GRANT SELECT, DELETE ON ${schema}.schema_migration TO ${role.name}`, []);

		expect(
			await codeOf(start({ within: schema, library: asTheLibrary, plugin: driver }).migrate()),
		).toBe(REACHES_THE_CORE);
	});
});

describe("a login that can make itself a member of the library's role refuses the start", () => {
	/** On PostgreSQL 14 and 15, which §7 supports, CREATEROLE may grant itself any role that is not
	 * a superuser, the library's included; the migration runner refuses the same attribute for the
	 * same reason (E-920). */
	it("refuses a login that may create roles", async () => {
		const { role, driver } = await aLogin("createrole");
		await owner.query(`ALTER ROLE ${role.name} CREATEROLE`, []);

		expect(
			await codeOf(start({ within: schema, library: asTheLibrary, plugin: driver }).migrate()),
		).toBe(REACHES_THE_CORE);
	});
});

describe("grants the check claims to count are counted", () => {
	it("refuses a login whose right on a core table comes from PUBLIC", async () => {
		const { driver } = await aLogin("public");
		await owner.query(`GRANT SELECT ON ${schema}.password_credential TO PUBLIC`, []);
		try {
			expect(
				await codeOf(start({ within: schema, library: asTheLibrary, plugin: driver }).migrate()),
			).toBe(REACHES_THE_CORE);
		} finally {
			await owner.query(`REVOKE SELECT ON ${schema}.password_credential FROM PUBLIC`, []);
		}
	});

	it("refuses a login that is a member of pg_read_all_data", async () => {
		const { role, driver } = await aLogin("read_all");
		await owner.query(`GRANT pg_read_all_data TO ${role.name}`, []);

		expect(
			await codeOf(start({ within: schema, library: asTheLibrary, plugin: driver }).migrate()),
		).toBe(REACHES_THE_CORE);
	});

	it("leaves no function in the core schema that runs with its owner's rights", async () => {
		const definers = await owner.query<{ name: string }>(
			`SELECT routine.oid::regprocedure::text AS name
			 FROM pg_proc routine JOIN pg_namespace schema_ ON schema_.oid = routine.pronamespace
			 WHERE schema_.nspname = $1 AND routine.prosecdef`,
			[schema],
		);

		expect(definers).toStrictEqual([]);
	});
});

describe("a pass is not remembered past the core tables it was measured against (S-OWNER-10)", () => {
	/** A process that never runs `migrate()` — migrations run by a separate job — checks its plugin
	 * login on the first plugin statement. Measured before the core tables exist it finds none, and
	 * the pass is kept for the life of the process even after another instance's `migrate()` has
	 * refused the same login. */
	it("refuses the next plugin statement once the core tables exist and the login reaches them", async () => {
		const fresh = uniqueSchemaName("pluginreachfresh");
		freshSchemas.push(fresh);
		await owner.query(`CREATE SCHEMA ${fresh}`, []);
		const freshMigrator = await createTheMigrationRole(owner, fresh);
		const library = await openTestConnection(freshMigrator.url);
		connections.push(library);
		const { role, driver } = await aLogin("remembered");
		await owner.query(
			`ALTER DEFAULT PRIVILEGES FOR ROLE ${freshMigrator.name} IN SCHEMA ${fresh} GRANT SELECT ON TABLES TO ${role.name}`,
			[],
		);
		await owner.query(`GRANT USAGE ON SCHEMA ${fresh} TO ${role.name}`, []);
		try {
			const servingProcess = ownTablesOf(start({ within: fresh, library, plugin: driver }));
			await codeOf(servingProcess.query(`SELECT note FROM ${fresh}.demo_entry`, []));

			const migratingJob = start({ within: fresh, library, plugin: driver }).migrate();
			expect(await codeOf(migratingJob)).toBe(REACHES_THE_CORE);
			await expect(
				driver.query(`SELECT token_sha256 FROM ${fresh}.session`, []),
			).resolves.toBeDefined();

			expect(await codeOf(servingProcess.query(`SELECT note FROM ${fresh}.demo_entry`, []))).toBe(
				REACHES_THE_CORE,
			);
		} finally {
			await library.close();
			connections.splice(connections.indexOf(library), 1);
			await dropSchema(owner, fresh);
			freshSchemas.splice(freshSchemas.indexOf(fresh), 1);
			await dropTheMigrationRole(owner, freshMigrator);
		}
	}, 60_000);
});
