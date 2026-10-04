import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import type { PluginActor, VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { openConnectionPool } from "./connection-pool-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { postTo } from "./flows-fixtures.js";

/**
 * The connection a reset lends its revoke hook is given back when the hook returns (E-2586). A
 * statement chain the hook started and did not await is refused at its next statement, and a
 * plugin statement that fails on the lent connection without a plugin role is rolled back to its
 * own savepoint, so a hook that catches the failure leaves the reset able to finish.
 */

const PASSWORD = "correct-horse-battery-staple";
const REPLACEMENT = "a different password entirely";
const ACTOR: PluginActor = { pluginId: "chain", reason: "the test leaves a chain running" };

type Behaviour = "leave_a_chain_running" | "catch_a_failing_statement";
let behaviour: Behaviour = "leave_a_chain_running";
let chainOutcome: Promise<"revoked" | "refused"> = Promise.resolve("refused");

const CHAIN: VelvePlugin<"chain"> = {
	id: "chain",
	hooks: {
		beforeSessionRevoke: async (event, context) => {
			if (behaviour === "catch_a_failing_statement") {
				await context.ownTables
					.query(`INSERT INTO ${context.schema}.chain_note (note) VALUES (NULL)`, [])
					.catch(() => undefined);
				await context.ownTables.query(
					`INSERT INTO ${context.schema}.chain_note (note) VALUES ($1)`,
					[event.sessionId],
				);
				return;
			}
			chainOutcome = context.repositories
				.listSessionsForUser({ userId: event.userId, actor: ACTOR })
				.then(() => new Promise((resolve) => setTimeout(resolve, 200)))
				.then(() =>
					context.repositories.listSessionsForUser({ userId: event.userId, actor: ACTOR }),
				)
				.then(
					() => "revoked" as const,
					() => "refused" as const,
				);
		},
	},
};

let connection: TestConnection;
let pool: Awaited<ReturnType<typeof openConnectionPool>>;
let schema: string;
let handler: (request: Request) => Promise<Response>;
const mailed: EmailMessage[] = [];

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("revokelent"));
	pool = await openConnectionPool(2, { acquireTimeoutMs: 10_000 });
	const auth = createVelveAuth(
		configFor({
			database: pool,
			schema,
			email: {
				send: (message) => {
					mailed.push(message);
					return Promise.resolve();
				},
			},
			plugins: [CHAIN],
			rateLimit: {
				perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
				perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
			},
		}),
	);
	await connection.query(
		`CREATE TABLE ${schema}.chain_note (id bigserial PRIMARY KEY, note text NOT NULL)`,
		[],
	);
	handler = toWebHandler(auth);
}, 120_000);

afterAll(async () => {
	await pool.close();
	await dropSchema(connection, schema);
	await connection.close();
});

beforeEach(() => {
	behaviour = "leave_a_chain_running";
});

let accounts = 0;

async function redeemAFreshReset(): Promise<Response> {
	accounts += 1;
	const email = `revokelent${accounts}@example.com`;
	expect((await handler(postTo("/sign-up", { email, password: PASSWORD }))).status).toBe(200);
	expect((await handler(postTo("/password/request-reset", { email }))).status).toBe(204);
	const message = mailed.find((sent) => sent.kind === "password_reset" && sent.to === email);
	if (message === undefined || message.kind !== "password_reset") {
		throw new Error("no reset message was sent");
	}
	return handler(
		postTo("/password/redeem-reset", { token: message.token, newPassword: REPLACEMENT }),
	);
}

describe("the connection lent to a reset's revoke hook ends with the hook (E-2586)", () => {
	it("refuses the next statement of a chain the hook left running", async () => {
		const answer = await redeemAFreshReset();

		expect(answer.status, await answer.clone().text()).toBe(200);
		expect(await chainOutcome).toBe("refused");
	}, 60_000);

	it("rolls a failing plugin statement back to its savepoint and lets the reset finish", async () => {
		behaviour = "catch_a_failing_statement";

		const answer = await redeemAFreshReset();

		expect(answer.status, await answer.clone().text()).toBe(200);
		const [row] = await connection.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM ${schema}.chain_note`,
			[],
		);
		expect(row?.count).toBe(1);
	}, 60_000);
});
