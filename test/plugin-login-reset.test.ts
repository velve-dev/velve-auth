import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import type { Driver } from "../src/core/db/driver.js";
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
 * A reset announces its revocations inside its own transaction and lends its hook that
 * transaction's connection (E-2584). With `pluginDatabase` set, the hook's own-table statements go
 * to the plugin login instead, each committed as it runs (E-2643): the reset finishes without
 * waiting on the hook's insert, which names the account the reset holds locked, and a hook that
 * refuses rolls the reset back and leaves its own note standing.
 */

const PASSWORD = "correct-horse-battery-staple";
const REPLACEMENT = "a different password entirely";

type Behaviour = "write" | "write_then_refuse";
let behaviour: Behaviour = "write";

const NOTER: VelvePlugin<"noter"> = {
	id: "noter",
	migrations: [
		{
			version: 1,
			name: "notes",
			createsTables: ["noter_note"],
			sql: `CREATE TABLE velve.noter_note (
				id bigserial PRIMARY KEY,
				session_id uuid NOT NULL,
				user_id uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE)`,
		},
	],
	hooks: {
		beforeSessionRevoke: async (event, context) => {
			await context.ownTables.query(
				`INSERT INTO ${context.schema}.noter_note (session_id, user_id) VALUES ($1, $2)`,
				[event.sessionId, event.userId],
			);
			if (behaviour === "write_then_refuse") {
				throw new Error("the noter refused the revocation");
			}
		},
	},
};

let owner: TestConnection;
let asTheLibrary: TestConnection;
let asThePlugin: TestConnection;
let schema: string;
let migrator: MigrationRole;
let pluginLogin: PluginLoginRole;
let handler: (request: Request) => Promise<Response>;
const statementsOnThePluginLogin: string[] = [];
const mailed: EmailMessage[] = [];

beforeAll(async () => {
	owner = await openTestConnection();
	schema = uniqueSchemaName("pluginreset");
	await runMigrations({ driver: owner, schema, migrations: coreMigrations("email") });
	migrator = await createTheMigrationRole(owner, schema);
	pluginLogin = await createAPluginLoginRole(owner, `${schema}_plugin_login`);
	asTheLibrary = await openTestConnection(migrator.url);
	asThePlugin = await openTestConnection(pluginLogin.url);
	const recordedPlugin: Driver = {
		query: <T>(sql: string, params: unknown[]): Promise<T[]> => {
			statementsOnThePluginLogin.push(sql);
			return asThePlugin.query<T>(sql, params);
		},
		transaction: (work) => asThePlugin.transaction(work),
	};
	const auth = createVelveAuth(
		configFor({
			database: asTheLibrary as Driver,
			schema,
			plugins: [NOTER],
			pluginDatabase: recordedPlugin,
			email: {
				send: (message) => {
					mailed.push(message);
					return Promise.resolve();
				},
			},
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

beforeEach(() => {
	behaviour = "write";
	statementsOnThePluginLogin.length = 0;
});

let accounts = 0;

async function accountWithResetToken(): Promise<{ userId: string; token: string }> {
	accounts += 1;
	const email = `pluginreset${accounts}@example.com`;
	const signedUp = await handler(postTo("/sign-up", { email, password: PASSWORD }));
	expect(signedUp.status, await signedUp.clone().text()).toBe(200);
	const requested = await handler(postTo("/password/request-reset", { email }));
	expect(requested.status).toBe(204);
	const message = mailed.find((sent) => sent.kind === "password_reset" && sent.to === email);
	if (message === undefined || message.kind !== "password_reset") {
		throw new Error("no reset message was sent");
	}
	return { userId: message.userId, token: message.token };
}

async function notesOf(userId: string): Promise<number> {
	const [row] = await owner.query<{ count: number }>(
		`SELECT count(*)::int AS count FROM ${schema}.noter_note WHERE user_id = $1`,
		[userId],
	);
	return row?.count ?? -1;
}

async function sessionsOf(userId: string): Promise<number> {
	const [row] = await owner.query<{ count: number }>(
		`SELECT count(*)::int AS count FROM ${schema}.session WHERE user_id = $1`,
		[userId],
	);
	return row?.count ?? -1;
}

function redeem(token: string): Promise<Response> {
	return handler(postTo("/password/redeem-reset", { token, newPassword: REPLACEMENT }));
}

describe("a reset's revoke hook writes its own table over the plugin login (E-2643)", () => {
	it("completes the reset after the hook wrote its note on the plugin login", async () => {
		const account = await accountWithResetToken();

		const answer = await redeem(account.token);

		expect(answer.status, await answer.clone().text()).toBe(200);
		expect(await notesOf(account.userId)).toBe(1);
		expect(await sessionsOf(account.userId)).toBe(1);
		expect(statementsOnThePluginLogin.filter((sql) => sql.includes("noter_note"))).toHaveLength(1);
	}, 60_000);

	it("rolls the reset back and keeps the note the refusing hook wrote", async () => {
		const account = await accountWithResetToken();
		behaviour = "write_then_refuse";

		const answer = await redeem(account.token);

		expect(answer.status).toBe(500);
		expect(await sessionsOf(account.userId)).toBe(1);
		expect(await notesOf(account.userId)).toBe(1);
	}, 60_000);
});
