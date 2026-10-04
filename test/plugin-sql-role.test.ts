import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import type { FrozenContext, VelvePlugin } from "../src/core/plugin/config.js";
import { runAsThePluginRole } from "../src/core/plugin/database-role.js";
import { createVelveAuth, type VelveAuth } from "../src/index.js";
import { configFor, createLogSink } from "./auth-fixtures.js";
import {
	createUser,
	dropSchema,
	insertRowOwnedBy,
	readColumns,
	uniqueSchemaName,
} from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import {
	createContextProbe,
	createTheMigrationRole,
	createThePluginRole,
	dropTheMigrationRole,
	dropThePluginRole,
	type MigrationRole,
} from "./plugin-fixtures.js";

const PERMISSION_DENIED = "42501";
const WEAKENED_LINE = "a security option is weaker than its default";

let owner: TestConnection;
let asTheLibrary: TestConnection;
let schema: string;
let migrator: MigrationRole;
let pluginRole: string;
let victim: string;

function demoPlugin(): VelvePlugin {
	return {
		...createContextProbe().plugin,
		migrations: [
			{
				version: 1,
				name: "entries",
				createsTables: ["demo_entry"],
				sql: `CREATE TABLE velve.demo_entry (
					id bigserial PRIMARY KEY,
					note text NOT NULL,
					user_id uuid REFERENCES velve.user(id) ON DELETE CASCADE)`,
			},
		],
	} as VelvePlugin;
}

function start(pluginDatabaseRole?: string): VelveAuth<"email"> {
	return createVelveAuth(
		configFor({
			database: asTheLibrary as Driver,
			schema,
			plugins: [demoPlugin()],
			...(pluginDatabaseRole === undefined ? {} : { pluginDatabaseRole }),
		}),
	);
}

function contextOfThePlugin(auth: VelveAuth<"email">): FrozenContext {
	const route = auth.routes.find((candidate) => candidate.name === "demo.echo");
	if (route === undefined) {
		throw new Error("the demo plugin contributed no route");
	}
	return auth.http.pluginContextOf(route);
}

async function sessionCount(): Promise<number> {
	const [row] = await owner.query<{ count: number }>(
		`SELECT count(*)::int AS count FROM ${schema}.session`,
		[],
	);
	return row?.count ?? -1;
}

async function sqlStateOf(attempt: Promise<unknown>): Promise<string | undefined> {
	try {
		await attempt;
		return undefined;
	} catch (error) {
		return (error as { sqlState?: string }).sqlState ?? String(error);
	}
}

beforeAll(async () => {
	owner = await openTestConnection();
	schema = uniqueSchemaName("pluginsql");
	await runMigrations({ driver: owner, schema, migrations: coreMigrations("email") });
	migrator = await createTheMigrationRole(owner, schema);
	pluginRole = await createThePluginRole(owner, schema, migrator);
	asTheLibrary = await openTestConnection(migrator.url);
	await start(pluginRole).migrate();
	victim = await createUser(owner, schema);
	await insertRowOwnedBy(
		owner,
		schema,
		{ table: "session", ownerColumn: "user_id" },
		victim,
		await readColumns(owner, schema),
	);
});

afterAll(async () => {
	await asTheLibrary?.close();
	await dropSchema(owner, schema);
	await dropThePluginRole(owner, pluginRole);
	await dropTheMigrationRole(owner, migrator);
	await owner.close();
});

/**
 * S-OWNER-10 says a plugin writes a core table through the repositories only. The statement check
 * in `ownTables.query` is lexical and says of itself that it is no sandbox (E-738), so with the
 * role configured the database refuses as well: the plugin's statement runs as a role that holds
 * rights on the plugin's own tables and on nothing else.
 */
describe("plugin SQL runs as a role without rights on the core tables (S-OWNER-10)", () => {
	it("lets the plugin write and read its own table", async () => {
		const ownTables = contextOfThePlugin(start(pluginRole)).ownTables;

		const written = await ownTables.query<{ id: string }>(
			`INSERT INTO ${schema}.demo_entry VALUES (DEFAULT, $1, $2) RETURNING id`,
			["kept", victim],
		);
		const read = await ownTables.query<{ note: string }>(
			`SELECT note FROM ${schema}.demo_entry WHERE id = $1`,
			[written[0]?.id],
		);

		expect(read).toStrictEqual([{ note: "kept" }]);
	});

	it("refuses at the database a write to the session table that got past the statement check", async () => {
		const before = await sessionCount();

		const states = [
			await sqlStateOf(
				runAsThePluginRole(asTheLibrary, pluginRole, `DELETE FROM ${schema}.session`, []),
			),
			await sqlStateOf(
				runAsThePluginRole(asTheLibrary, pluginRole, `UPDATE ${schema}.session SET user_id = $1`, [
					victim,
				]),
			),
			await sqlStateOf(
				runAsThePluginRole(
					asTheLibrary,
					pluginRole,
					`WITH reset AS (SELECT set_config('role', 'none', true))
					 DELETE FROM ${schema}.session WHERE EXISTS (SELECT 1 FROM reset)`,
					[],
				),
			),
		];

		expect(states).toStrictEqual([PERMISSION_DENIED, PERMISSION_DENIED, PERMISSION_DENIED]);
		expect(await sessionCount()).toBe(before);
		expect(before).toBe(1);
	});

	/**
	 * The statement check now refuses query_to_xml by name (E-2454), so the read a literal smuggles
	 * past it is sent below the check, as the write cases above are, to show what the role alone does.
	 */
	it("refuses at the database a core table named inside a literal that query_to_xml runs", async () => {
		const smuggled = `SELECT query_to_xml('select token_sha256 from ${schema}.session', true, false, '') AS leaked FROM ${schema}.demo_entry`;

		const withTheRole = await sqlStateOf(
			runAsThePluginRole(asTheLibrary, pluginRole, smuggled, []),
		);
		const withoutTheRole = await asTheLibrary.query<{ leaked: string }>(smuggled, []);
		const refusedByTheCheck = await contextOfThePlugin(start())
			.ownTables.query(smuggled, [])
			.then(
				() => "reached the database",
				(error: { code?: string }) => error.code,
			);

		expect(withTheRole).toBe(PERMISSION_DENIED);
		expect(withoutTheRole.length).toBeGreaterThan(0);
		expect(withoutTheRole[0]?.leaked).toContain("token_sha256");
		expect(refusedByTheCheck).toBe("plugin_table_not_its_own");
	});
});

describe("an instance with plugins and no database role reports the weakening at start (S-DEFAULT-1)", () => {
	function pluginsLineOf(pluginDatabaseRole?: string): unknown {
		const log = createLogSink();
		createVelveAuth(
			configFor({
				database: asTheLibrary as Driver,
				schema,
				plugins: [demoPlugin()],
				log: log.write,
				...(pluginDatabaseRole === undefined ? {} : { pluginDatabaseRole }),
			}),
		);
		const weakened = log.lines.filter(
			(line) => line.message === WEAKENED_LINE && line.fields.option === "plugins",
		);
		expect(weakened).toHaveLength(1);
		return weakened[0]?.fields.chosen;
	}

	it("names the missing role in the plugins line when none is configured", () => {
		expect(pluginsLineOf()).toContain("pluginDatabaseRole");
	});

	it("names the role in the plugins line when one is configured", () => {
		const chosen = pluginsLineOf(pluginRole);

		expect(chosen).toContain(pluginRole);
		expect(chosen).not.toContain("no pluginDatabaseRole");
	});

	it("starts rather than refusing, because every plugin running today has no role", () => {
		expect(() => start()).not.toThrow();
	});
});

describe("the role name is refused at start when it would not switch to a role", () => {
	it.each(["none", "public", "pg_read_all_data", "current_user", "Plugins", "a;b"])(
		"refuses %s",
		(name) => {
			expect(() => start(name)).toThrow();
		},
	);
});
