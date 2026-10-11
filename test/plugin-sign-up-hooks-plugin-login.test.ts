import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import type { VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { dropSchema, uniqueSchemaName } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { postTo } from "./flows-fixtures.js";
import {
	createAPluginLoginRole,
	createTheMigrationRole,
	dropAPluginLoginRole,
	dropTheMigrationRole,
	type MigrationRole,
	type PluginLoginRole,
} from "./plugin-fixtures.js";

/**
 * DOCUMENTATION.md says of a sign-up's hooks inside the registration that with `pluginDatabase` set
 * `ownTables.query` goes to the plugin login, "so its writes commit at once and stay when a cover
 * rolls back" (E-2795), and of an OAuth sign-up the same (E-2797). A plugin table with a foreign key
 * to `velve.user` is the shape the plugin tests themselves migrate. The plugin login cannot see the
 * account row the registration has written and not committed, so a hook's insert keyed to the
 * `userId` that `afterUserCreate` names is refused with `23503`, the hook throws, and the sign-up
 * answers `internal_error`; nothing is written and nothing commits. A wait was expected and
 * `lock_timeout` bounds the plugin login in case one occurs, but the refusal comes at once. The
 * first case pins what happens; the second asks the reference to say it.
 */

const PASSWORD = "correct-horse-battery-staple";
const PLUGIN_LOCK_TIMEOUT = "3s";

let owner: TestConnection;
let asTheLibrary: TestConnection;
let asThePlugin: TestConnection;
let schema: string;
let migrator: MigrationRole;
let pluginLogin: PluginLoginRole;
let handler: (request: Request) => Promise<Response>;
const hookOutcomes: string[] = [];

function signUpLog(): VelvePlugin<"signuplog"> {
	return {
		id: "signuplog",
		migrations: [
			{
				version: 1,
				name: "entries",
				createsTables: ["signuplog_entry"],
				sql: `CREATE TABLE velve.signuplog_entry (
					id bigserial PRIMARY KEY,
					user_id uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE)`,
			},
		],
		hooks: {
			afterUserCreate: async (event, context) => {
				try {
					await context.ownTables.query(
						`INSERT INTO ${schema}.signuplog_entry (user_id) VALUES ($1)`,
						[event.userId],
					);
					hookOutcomes.push("written");
				} catch (error) {
					hookOutcomes.push((error as { sqlState?: string }).sqlState ?? String(error));
					throw error;
				}
			},
		},
	};
}

beforeAll(async () => {
	owner = await openTestConnection();
	schema = uniqueSchemaName("signuplogin");
	await runMigrations({ driver: owner, schema, migrations: coreMigrations("email") });
	migrator = await createTheMigrationRole(owner, schema);
	pluginLogin = await createAPluginLoginRole(owner, `${schema}_plugin_login`);
	asTheLibrary = await openTestConnection(migrator.url);
	asThePlugin = await openTestConnection(pluginLogin.url);
	await asThePlugin.query(`SET lock_timeout = '${PLUGIN_LOCK_TIMEOUT}'`, []);
	const auth = createVelveAuth(
		configFor({
			database: asTheLibrary,
			schema,
			plugins: [signUpLog()],
			pluginDatabase: asThePlugin,
			rateLimit: {
				perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
				perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
			},
		}),
	);
	await auth.migrate();
	handler = toWebHandler(auth);
}, 120_000);

afterAll(async () => {
	await asThePlugin?.close();
	await asTheLibrary?.close();
	await dropSchema(owner, schema);
	await dropAPluginLoginRole(owner, pluginLogin.name);
	await dropTheMigrationRole(owner, migrator);
	await owner.close();
});

function signUpHookChapter(): string {
	const reference = readFileSync(new URL("../DOCUMENTATION.md", import.meta.url), "utf8");
	const from = reference.indexOf("**A sign-up runs all four of its points");
	const to = reference.indexOf("**The password operations that issue a session");
	return reference.slice(from, to);
}

describe("a sign-up hook writing its own table over the plugin login (E-2795, pluginDatabase)", () => {
	it("refuses the hook's row for the created account and answers internal_error", async () => {
		const email = "signuplogin@example.com";

		const answer = await handler(postTo("/sign-up", { email, password: PASSWORD }));
		const [row] = await owner.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM ${schema}.signuplog_entry`,
			[],
		);

		expect([hookOutcomes, answer.status, row?.count]).toStrictEqual([["23503"], 500, 0]);
	}, 30_000);

	it("says in the reference that such a write is refused rather than committed at once", () => {
		const chapter = signUpHookChapter();

		expect(chapter).not.toBe("");
		expect(chapter).toMatch(/foreign key/i);
	});
});
