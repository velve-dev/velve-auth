import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import type { FrozenContext, VelvePlugin } from "../src/core/plugin/config.js";
import { createOwnTables } from "../src/core/plugin/own-tables.js";
import { createVelveAuth, type VelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
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

interface RecordingDriver extends Driver {
	readonly reached: readonly string[];
}

function recordingDriver(reached: string[] = []): RecordingDriver {
	return {
		reached,
		query: <T>(sql: string): Promise<T[]> => {
			reached.push(sql);
			return Promise.resolve([]);
		},
		transaction: <T>(fn: (tx: Driver) => Promise<T>): Promise<T> => fn(recordingDriver(reached)),
	};
}

async function statementsThatReachedTheDriver(statements: readonly string[]): Promise<string[]> {
	const driver = recordingDriver();
	const ownTables = createOwnTables({
		driver,
		schema: "velve",
		pluginId: "demo",
		databaseRole: "velve_plugins",
	});
	const passed: string[] = [];
	for (const sql of statements) {
		const reachedBefore = driver.reached.length;
		await ownTables.query(sql, []).catch(() => undefined);
		if (driver.reached.length > reachedBefore) {
			passed.push(sql);
		}
	}
	return passed;
}

/**
 * The role is a ceiling only while the statement cannot leave it. `SET` and `RESET` are refused by
 * the leading-word rule, so the one way back to the library's login role from inside a single
 * plugin statement is `set_config('role', …)`, and the way to reach a core table named only inside a
 * literal is a function that runs SQL text. Both are names the tokenizer sees outside literals, so
 * refusing them costs no ordinary statement — a literal holding the same words is data and passes.
 * A plugin is JavaScript in the operator's process and can open its own connection; this is about
 * faulty plugin SQL, which is what the role is for (E-738, E-2451).
 */
describe("the statement check refuses the functions that leave the plugin role or run SQL text (S-OWNER-10)", () => {
	const ESCAPES = [
		"SELECT set_config('role', 'none', true) FROM velve.demo_entry",
		"SELECT pg_catalog.set_config('role', 'none', false)",
		`SELECT "set_config"('role', 'none', true)`,
		"SELECT SET_CONFIG('role', 'none', true)",
		"SELECT query_to_xml('select 1', true, false, '') FROM demo_entry",
		"SELECT pg_catalog.query_to_xml('select 1', true, false, '')",
		"SELECT query_to_xmlschema('select 1', true, false, '')",
		"SELECT query_to_xml_and_xmlschema('select 1', true, false, '')",
		"SELECT cursor_to_xml('c', 1, true, false, '')",
		"SELECT ts_stat('select set_config(''role'', ''none'', true)::tsvector')",
		"SELECT ts_rewrite('a'::tsquery, 'select 1')",
		"SELECT * FROM dblink('dbname=velve', 'select 1') AS t(x int)",
	];

	it.each(ESCAPES)("refuses %s before it reaches the driver", async (sql) => {
		expect(await statementsThatReachedTheDriver([sql])).toStrictEqual([]);
	});

	it("still lets the same words through as data inside a literal", async () => {
		const asData = [
			"INSERT INTO demo_entry VALUES (DEFAULT, 'set_config and query_to_xml', $1)",
			"SELECT * FROM demo_entry WHERE note = 'select set_config(''role'', ''none'', true)'",
		];

		expect(await statementsThatReachedTheDriver(asData)).toStrictEqual(asData);
	});
});

let owner: TestConnection;
let asTheLibrary: TestConnection;
let schema: string;
let migrator: MigrationRole;
let pluginRole: string;
let victim: string;

function demoPlugin(createsTables: readonly string[] = ["demo_entry"]): VelvePlugin {
	return {
		...createContextProbe().plugin,
		migrations: [
			{
				version: 1,
				name: "entries",
				createsTables,
				sql: `CREATE TABLE velve.demo_entry (
					id bigserial PRIMARY KEY,
					note text NOT NULL,
					user_id uuid REFERENCES velve.user(id) ON DELETE CASCADE)`,
			},
		],
	} as VelvePlugin;
}

function start(createsTables?: readonly string[]): VelveAuth<"email"> {
	return createVelveAuth(
		configFor({
			database: asTheLibrary as Driver,
			schema,
			plugins: [demoPlugin(createsTables)],
			pluginDatabaseRole: pluginRole,
		}),
	);
}

function ownTablesOfThePlugin(): FrozenContext["ownTables"] {
	const auth = start();
	const route = auth.routes.find((candidate) => candidate.name === "demo.echo");
	if (route === undefined) {
		throw new Error("the demo plugin contributed no route");
	}
	return auth.http.pluginContextOf(route).ownTables;
}

async function outcomeOf(attempt: Promise<unknown>): Promise<unknown> {
	try {
		return await attempt;
	} catch (error) {
		return (error as { code?: string; sqlState?: string }).code ?? "refused";
	}
}

beforeAll(async () => {
	owner = await openTestConnection();
	schema = uniqueSchemaName("pluginsqlreview");
	await runMigrations({ driver: owner, schema, migrations: coreMigrations("email") });
	migrator = await createTheMigrationRole(owner, schema);
	pluginRole = await createThePluginRole(owner, schema, migrator);
	asTheLibrary = await openTestConnection(migrator.url);
	await start().migrate();
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
	await asTheLibrary?.query("RESET ROLE", []).catch(() => undefined);
	await asTheLibrary?.close();
	await dropSchema(owner, schema);
	await dropThePluginRole(owner, pluginRole);
	await dropTheMigrationRole(owner, migrator);
	await owner.close();
});

describe("with pluginDatabaseRole set, plugin SQL stays below the role (S-OWNER-10)", () => {
	it("does not read the session table through a role reset and query_to_xml (E-2451)", async () => {
		const leaked = await outcomeOf(
			ownTablesOfThePlugin().query<{ leaked: string }>(
				`SELECT set_config('role', 'none', true) AS reset,
				        query_to_xml('select token_sha256 from ${schema}.session', true, false, '') AS leaked`,
				[],
			),
		);

		expect(JSON.stringify(leaked)).not.toContain("token_sha256");
	});

	it("does not hand the next borrower of the connection a role the plugin chose", async () => {
		await outcomeOf(
			ownTablesOfThePlugin().query(`SELECT set_config('role', '${pluginRole}', false)`, []),
		);

		const [after] = await asTheLibrary.query<{ role: string }>("SELECT current_user AS role", []);
		await asTheLibrary.query("RESET ROLE", []);

		expect(after?.role).toBe(migrator.name);
	});

	it("lets a plugin insert naming more than one column (E-2453)", async () => {
		const written = await outcomeOf(
			ownTablesOfThePlugin().query<{ id: string }>(
				`INSERT INTO ${schema}.demo_entry (note, user_id) VALUES ($1, $2) RETURNING id`,
				["two columns", victim],
			),
		);

		expect(Array.isArray(written) && written.length === 1).toBe(true);
	});

	/**
	 * `migrate()` reads the declared names from the configuration on every run, and the checksum of
	 * an applied migration covers its SQL only, so a declaration can change after the table exists.
	 * A declared name passes the prefix rule as long as it begins with the plugin id, and the grant
	 * splits the joined names on commas, so one declared name may carry a core table behind a comma.
	 */
	it("grants nothing on a core table whatever a declared name contains", async () => {
		//the start itself refuses the name since E-2481 and that refusal is an outcome too
		await outcomeOf(Promise.resolve().then(() => start(["demo_entry,session"]).migrate()));

		const [granted] = await owner.query<{ allowed: boolean }>(
			"SELECT has_table_privilege($1, $2, 'DELETE') AS allowed",
			[pluginRole, `${schema}.session`],
		);

		expect(granted?.allowed).toBe(false);
	});
});
