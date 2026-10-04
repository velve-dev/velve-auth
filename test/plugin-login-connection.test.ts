import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import type { FrozenContext, VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth, type VelveAuth, type VelveAuthConfig } from "../src/index.js";
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
	createAPluginLoginRole,
	createContextProbe,
	createTheMigrationRole,
	dropAPluginLoginRole,
	dropTheMigrationRole,
	type MigrationRole,
	type PluginLoginRole,
} from "./plugin-fixtures.js";

const PERMISSION_DENIED = "42501";
const WEAKENED_LINE = "a security option is weaker than its default";
const REACHES_THE_CORE = "plugin_database_reaches_the_core";

let owner: TestConnection;
let asTheLibrary: TestConnection;
let asThePlugin: TestConnection;
let asAMemberOfTheLibrary: TestConnection;
let schema: string;
let migrator: MigrationRole;
let pluginLogin: PluginLoginRole;
let memberLogin: PluginLoginRole;
let victim: string;

interface RecordingDriver extends Driver {
	readonly statements: string[];
}

function recording(driver: Driver): RecordingDriver {
	const statements: string[] = [];
	return {
		statements,
		query: <T>(sql: string, params: unknown[]): Promise<T[]> => {
			statements.push(sql);
			return driver.query<T>(sql, params);
		},
		transaction: <T>(work: (tx: Driver) => Promise<T>): Promise<T> =>
			driver.transaction((tx) =>
				work({
					query: <R>(sql: string, params: unknown[]): Promise<R[]> => {
						statements.push(sql);
						return tx.query<R>(sql, params);
					},
					transaction: tx.transaction.bind(tx),
				}),
			),
	};
}

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

function start(
	overrides: Partial<VelveAuthConfig<"email">> = {},
	database: Driver = asTheLibrary,
): VelveAuth<"email"> {
	return createVelveAuth(configFor({ database, schema, plugins: [demoPlugin()], ...overrides }));
}

function contextOfThePlugin(auth: VelveAuth<"email">): FrozenContext {
	const route = auth.routes.find((candidate) => candidate.name === "demo.echo");
	if (route === undefined) {
		throw new Error("the demo plugin contributed no route");
	}
	return auth.http.pluginContextOf(route);
}

async function sqlStateOf(attempt: Promise<unknown>): Promise<string | undefined> {
	try {
		await attempt;
		return undefined;
	} catch (error) {
		return (error as { sqlState?: string }).sqlState ?? String(error);
	}
}

async function codeOf(attempt: Promise<unknown>): Promise<string | undefined> {
	try {
		await attempt;
		return undefined;
	} catch (error) {
		return (error as { code?: string }).code ?? String(error);
	}
}

async function sessionCount(): Promise<number> {
	const [row] = await owner.query<{ count: number }>(
		`SELECT count(*)::int AS count FROM ${schema}.session`,
		[],
	);
	return row?.count ?? -1;
}

beforeAll(async () => {
	owner = await openTestConnection();
	schema = uniqueSchemaName("pluginlogin");
	await runMigrations({ driver: owner, schema, migrations: coreMigrations("email") });
	migrator = await createTheMigrationRole(owner, schema);
	pluginLogin = await createAPluginLoginRole(owner, `${schema}_plugin_login`);
	memberLogin = await createAPluginLoginRole(owner, `${schema}_member_login`, {
		memberOf: migrator.name,
	});
	asTheLibrary = await openTestConnection(migrator.url);
	asThePlugin = await openTestConnection(pluginLogin.url);
	asAMemberOfTheLibrary = await openTestConnection(memberLogin.url);
	await start({ pluginDatabase: asThePlugin }).migrate();
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
	await asThePlugin?.close();
	await asAMemberOfTheLibrary?.close();
	await asTheLibrary?.close();
	await dropSchema(owner, schema);
	await dropAPluginLoginRole(owner, pluginLogin.name);
	await dropAPluginLoginRole(owner, memberLogin.name);
	await dropTheMigrationRole(owner, migrator);
	await owner.close();
});

/**
 * S-OWNER-10 with `pluginDatabase`: every plugin statement is sent on a connection that logged in as
 * a role holding rights on the plugins' own tables and on nothing else, and that is no member of the
 * library's role. There is no role to reset to, so the read E-2451 left open is closed by the
 * database and no longer by the list of refused functions (E-2454).
 */
describe("plugin SQL runs over its own login connection (S-OWNER-10)", () => {
	it("sends the plugin's own-table statements to the plugin connection and none to the library's", async () => {
		const library = recording(asTheLibrary);
		const plugin = recording(asThePlugin);
		const ownTables = contextOfThePlugin(start({ pluginDatabase: plugin }, library)).ownTables;

		const written = await ownTables.query<{ id: string }>(
			`INSERT INTO ${schema}.demo_entry (note, user_id) VALUES ($1, $2) RETURNING id`,
			["kept", victim],
		);
		const read = await ownTables.query<{ note: string }>(
			`SELECT note FROM ${schema}.demo_entry WHERE id = $1`,
			[written[0]?.id],
		);

		expect(read).toStrictEqual([{ note: "kept" }]);
		expect(plugin.statements.filter((sql) => sql.includes("demo_entry"))).toHaveLength(2);
		expect(library.statements.filter((sql) => sql.includes("demo_entry"))).toHaveLength(0);
		expect(plugin.statements.some((sql) => /SET\s+LOCAL\s+ROLE/i.test(sql))).toBe(false);
	});

	it("refuses at the database every route to a core table sent below the statement check", async () => {
		const before = await sessionCount();

		const states = [
			await sqlStateOf(asThePlugin.query(`SELECT token_sha256 FROM ${schema}.session`, [])),
			await sqlStateOf(
				asThePlugin.query(
					`SELECT set_config('role', 'none', true) AS reset,
					        query_to_xml('select token_sha256 from ${schema}.session', true, false, '') AS leaked`,
					[],
				),
			),
			await sqlStateOf(
				asThePlugin.query(
					`SELECT query_to_xml('select phc from ${schema}.password_credential', true, false, '') AS leaked`,
					[],
				),
			),
			await sqlStateOf(asThePlugin.query(`SET ROLE ${migrator.name}`, [])),
			await sqlStateOf(asThePlugin.query(`DELETE FROM ${schema}.session`, [])),
			await sqlStateOf(asThePlugin.query(`UPDATE ${schema}.session SET user_id = $1`, [victim])),
		];

		expect(states).toStrictEqual(Array(states.length).fill(PERMISSION_DENIED));
		expect(await sessionCount()).toBe(before);
		expect(before).toBe(1);
	});
});

describe("a plugin connection that is or can become the library's role refuses the start", () => {
	it("refuses the library's own connection at migrate()", async () => {
		expect(await codeOf(start({ pluginDatabase: asTheLibrary }).migrate())).toBe(REACHES_THE_CORE);
	});

	it("refuses a login that is a member of the library's role at migrate()", async () => {
		expect(await codeOf(start({ pluginDatabase: asAMemberOfTheLibrary }).migrate())).toBe(
			REACHES_THE_CORE,
		);
	});

	it("refuses a superuser login at migrate()", async () => {
		expect(await codeOf(start({ pluginDatabase: owner }).migrate())).toBe(REACHES_THE_CORE);
	});

	it("refuses the first plugin statement on an instance whose migrate() never ran", async () => {
		const ownTables = contextOfThePlugin(start({ pluginDatabase: asTheLibrary })).ownTables;

		expect(await codeOf(ownTables.query(`SELECT note FROM ${schema}.demo_entry`, []))).toBe(
			REACHES_THE_CORE,
		);
	});

	it("starts with a separate login and grants it the plugin's own tables", async () => {
		await expect(start({ pluginDatabase: asThePlugin }).migrate()).resolves.toBeDefined();
	});
});

describe("a plugin login that can create objects or roles refuses the start (E-2646)", () => {
	async function refusedWith(grant: string, revoke: string): Promise<string | undefined> {
		const login = await createAPluginLoginRole(owner, `${schema}_creator`);
		const driver = await openTestConnection(login.url);
		await owner.query(grant.replaceAll("<login>", login.name), []);
		try {
			return await codeOf(start({ pluginDatabase: driver }).migrate());
		} finally {
			await owner.query(revoke.replaceAll("<login>", login.name), []);
			await driver.close();
			await dropAPluginLoginRole(owner, login.name);
		}
	}

	it("refuses a login that may create objects in the core schema", async () => {
		expect(
			await refusedWith(
				`GRANT CREATE ON SCHEMA ${schema} TO <login>`,
				`REVOKE CREATE ON SCHEMA ${schema} FROM <login>`,
			),
		).toBe(REACHES_THE_CORE);
	});

	it("refuses a login that may create objects in the schema public", async () => {
		expect(
			await refusedWith(
				"GRANT CREATE ON SCHEMA public TO <login>",
				"REVOKE CREATE ON SCHEMA public FROM <login>",
			),
		).toBe(REACHES_THE_CORE);
	});
});

describe("a pass is measured against the core tables and does not last forever (E-2646, E-2647)", () => {
	it("refuses plugin SQL until the core tables exist, rather than passing a check that found none", async () => {
		const empty = uniqueSchemaName("pluginloginempty");
		await owner.query(`CREATE SCHEMA ${empty}`, []);
		try {
			const ownTables = contextOfThePlugin(
				createVelveAuth(
					configFor({
						database: asTheLibrary as Driver,
						schema: empty,
						plugins: [demoPlugin()],
						pluginDatabase: asThePlugin,
					}),
				),
			).ownTables;

			expect(await codeOf(ownTables.query(`SELECT note FROM ${empty}.demo_entry`, []))).toBe(
				"plugin_database_unchecked",
			);
		} finally {
			await dropSchema(owner, empty);
		}
	});

	it("asks again once the remembered pass is five minutes old, and sees a grant made since", async () => {
		let now = Date.parse("2026-10-04T12:00:00Z");
		const ownTables = contextOfThePlugin(
			start({ pluginDatabase: asThePlugin, clock: { now: () => new Date(now) } }),
		).ownTables;
		const read = (): Promise<string | undefined> =>
			codeOf(ownTables.query(`SELECT note FROM ${schema}.demo_entry`, []));

		expect(await read()).toBeUndefined();
		await owner.query(`GRANT SELECT ON ${schema}.session TO ${pluginLogin.name}`, []);
		try {
			now += 4 * 60 * 1000;
			const withinTheInterval = await read();
			now += 60 * 1000;
			const afterTheInterval = await read();

			expect(withinTheInterval).toBeUndefined();
			expect(afterTheInterval).toBe(REACHES_THE_CORE);
		} finally {
			await owner.query(`REVOKE SELECT ON ${schema}.session FROM ${pluginLogin.name}`, []);
		}
	});
});

describe("pluginDatabase and pluginDatabaseRole together", () => {
	it("refuses the start, because only one of them can say where plugin SQL runs", () => {
		expect(() =>
			start({ pluginDatabase: asThePlugin, pluginDatabaseRole: "velve_plugins" }),
		).toThrow(expect.objectContaining({ code: "plugin_database_and_role_both_set" }));
	});
});

describe("the plugins line of the start log says how plugin SQL is bounded (S-DEFAULT-1)", () => {
	function pluginsLineOf(overrides: Partial<VelveAuthConfig<"email">>): string {
		const log = createLogSink();
		start({ log: log.write, ...overrides });
		const weakened = log.lines.filter(
			(line) => line.message === WEAKENED_LINE && line.fields.option === "plugins",
		);
		expect(weakened).toHaveLength(1);
		return String(weakened[0]?.fields.chosen);
	}

	it("reports no weakening of plugin SQL with its own login connection", () => {
		expect(pluginsLineOf({ pluginDatabase: asThePlugin })).not.toContain("plugin SQL");
	});

	it("reports a role alone as a partial measure that leaves reads to the statement check", () => {
		const chosen = pluginsLineOf({ pluginDatabaseRole: "velve_plugins" });

		expect(chosen).toContain("velve_plugins");
		expect(chosen).toContain("pluginDatabase");
		expect(chosen).toContain("read");
	});

	it("reports the library's own role when neither is set, as before", () => {
		expect(pluginsLineOf({})).toContain("plugin SQL runs as the library's own role");
	});
});
