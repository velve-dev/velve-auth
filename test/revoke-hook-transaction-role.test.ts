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
	createTheMigrationRole,
	createThePluginRole,
	dropTheMigrationRole,
	dropThePluginRole,
	type MigrationRole,
} from "./plugin-fixtures.js";

/**
 * A reset hands its revoke hook a context bound to the reset's own transaction (E-2584). With
 * `pluginDatabaseRole` configured, each plugin statement switches that connection to the plugin
 * role, and the reset's own writes after the hook must run as the library again: a role left
 * standing would refuse them. A plugin statement the database refuses must leave the transaction
 * usable, and a refusing hook must take its own writes with it when the reset rolls back.
 */

const PASSWORD = "correct-horse-battery-staple";
const REPLACEMENT = "a different password entirely";

type Behaviour = "write" | "write_then_refuse" | "fail_a_statement_then_write";
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
			const table = `${context.schema}.noter_note`;
			if (behaviour === "fail_a_statement_then_write") {
				await context.ownTables
					.query(`INSERT INTO ${table} (session_id, user_id) VALUES (NULL, $1)`, [event.userId])
					.catch(() => undefined);
			}
			await context.ownTables.query(`INSERT INTO ${table} (session_id, user_id) VALUES ($1, $2)`, [
				event.sessionId,
				event.userId,
			]);
			if (behaviour === "write_then_refuse") {
				throw new Error("the noter refused the revocation");
			}
		},
	},
};

let owner: TestConnection;
let asTheLibrary: TestConnection;
let schema: string;
let migrator: MigrationRole;
let pluginRole: string;
let handler: (request: Request) => Promise<Response>;
const mailed: EmailMessage[] = [];

beforeAll(async () => {
	owner = await openTestConnection();
	schema = uniqueSchemaName("revokerole");
	await runMigrations({ driver: owner, schema, migrations: coreMigrations("email") });
	migrator = await createTheMigrationRole(owner, schema);
	pluginRole = await createThePluginRole(owner, schema, migrator);
	asTheLibrary = await openTestConnection(migrator.url);
	const auth = createVelveAuth(
		configFor({
			database: asTheLibrary as Driver,
			schema,
			plugins: [NOTER],
			pluginDatabaseRole: pluginRole,
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
	await asTheLibrary?.close();
	await dropSchema(owner, schema);
	await dropThePluginRole(owner, pluginRole);
	await dropTheMigrationRole(owner, migrator);
	await owner.close();
});

beforeEach(() => {
	behaviour = "write";
});

let accounts = 0;

async function accountWithResetToken(): Promise<{ userId: string; token: string }> {
	accounts += 1;
	const email = `revokerole${accounts}@example.com`;
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

describe("a revoke hook on a reset's connection runs its SQL as the plugin role only (E-2584)", () => {
	it("completes the reset after the hook wrote its own table under the plugin role", async () => {
		const account = await accountWithResetToken();

		const answer = await redeem(account.token);

		expect(answer.status, await answer.clone().text()).toBe(200);
		expect(await notesOf(account.userId)).toBe(1);
		expect(await sessionsOf(account.userId)).toBe(1);
	}, 60_000);

	it("keeps the reset usable after a plugin statement the database refused", async () => {
		const account = await accountWithResetToken();
		behaviour = "fail_a_statement_then_write";

		const answer = await redeem(account.token);

		expect(answer.status, await answer.clone().text()).toBe(200);
		expect(await notesOf(account.userId)).toBe(1);
	}, 60_000);

	it("rolls the hook's own writes back with the reset when the hook refuses", async () => {
		const account = await accountWithResetToken();
		behaviour = "write_then_refuse";

		const answer = await redeem(account.token);

		expect(answer.status).toBe(500);
		expect(await notesOf(account.userId)).toBe(0);
		expect(await sessionsOf(account.userId)).toBe(1);
	}, 60_000);
});
