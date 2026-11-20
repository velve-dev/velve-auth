import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import type { FrozenContext, VelvePlugin } from "../src/core/plugin/config.js";
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

/**
 * S-OWNER-10 with `pluginDatabaseRole` set: plugin SQL is meant to run as a role without rights
 * on the core tables. The role is entered with `SET LOCAL ROLE`, which `RESET ROLE` leaves again
 * without any privilege, and node-postgres — like the test connection — sends a statement without
 * parameters as a simple query, which may hold several statements. The lexical check refuses a
 * `;` and `RESET`, but an `E'\''` literal makes it read the rest of the text as data.
 */

let owner: TestConnection;
let asTheLibrary: TestConnection;
let schema: string;
let migrator: MigrationRole;
let pluginRole: string;

function demoPlugin(): VelvePlugin {
	return {
		...createContextProbe().plugin,
		migrations: [
			{
				version: 1,
				name: "entries",
				createsTables: ["demo_entry"],
				sql: "CREATE TABLE velve.demo_entry (id bigserial PRIMARY KEY, note text)",
			},
		],
	} as VelvePlugin;
}

function start(): VelveAuth<"email"> {
	return createVelveAuth(
		configFor({
			database: asTheLibrary as Driver,
			schema,
			plugins: [demoPlugin()],
			pluginDatabaseRole: pluginRole,
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

beforeAll(async () => {
	owner = await openTestConnection();
	schema = uniqueSchemaName("secplugrole");
	await runMigrations({ driver: owner, schema, migrations: coreMigrations("email") });
	migrator = await createTheMigrationRole(owner, schema);
	pluginRole = await createThePluginRole(owner, schema, migrator);
	asTheLibrary = await openTestConnection(migrator.url);
	await start().migrate();
	const victim = await createUser(owner, schema);
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

describe("plugin SQL cannot leave the plugin role (S-OWNER-10, pluginDatabaseRole)", () => {
	it("refuses a statement list that resets the role and deletes every session", async () => {
		const before = await sessionCount();
		const ownTables = contextOfThePlugin(start()).ownTables;

		const outcome = await ownTables
			.query(`SELECT E'\\''; RESET ROLE; DELETE FROM ${schema}.session; SELECT --'`, [])
			.then(
				() => "reached the core table",
				(error: { code?: string; sqlState?: string }) => error.code ?? error.sqlState,
			);

		expect(before).toBe(1);
		expect(outcome).not.toBe("reached the core table");
		expect(await sessionCount(), "sessions left after the plugin's statement").toBe(before);
	});
});
