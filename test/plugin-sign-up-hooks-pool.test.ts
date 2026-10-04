import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toWebHandler } from "../src/core/http/web-handler.js";
import type { PluginActor, VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { openConnectionPool } from "./connection-pool-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { postTo } from "./flows-fixtures.js";

/**
 * A sign-up's `afterUserCreate`, `beforeSessionCreate` and `afterSessionCreate` reach a plugin
 * whose context runs on the pool (3.11, 3.15 G). One test connection nests every transaction into
 * one session, so it sees the registration's uncommitted row and holds no second connection; a
 * pool, as every real driver has, shows what a plugin meets. Two properties follow from the hook
 * contract and from E-2584, which settled that a hook told inside a transaction must not ask the
 * pool for a second connection: the account an `after` point names is one the plugin's own
 * repositories can find, and as many concurrent sign-ups as the pool has connections all finish
 * when their hooks read.
 */

const POOL_SIZE = 3;
const ACQUIRE_TIMEOUT_MS = 10_000;
const BARRIER_TIMEOUT_MS = 5_000;
const PASSWORD = "correct-horse-battery-staple";
const ACTOR: PluginActor = { pluginId: "reader", reason: "the test reads the created account" };

type Behaviour = "find_the_created_account" | "wait_for_every_sign_up_then_read";
let behaviour: Behaviour = "find_the_created_account";
const foundOnCreate: (string | null)[] = [];

let arrived = 0;
let releaseBarrier: () => void = () => undefined;
const barrier = new Promise<void>((resolve) => {
	releaseBarrier = resolve;
});

function waitForEverySignUp(): Promise<void> {
	arrived += 1;
	if (arrived >= POOL_SIZE) {
		releaseBarrier();
	}
	return Promise.race([
		barrier,
		new Promise<void>((resolve) => setTimeout(resolve, BARRIER_TIMEOUT_MS)),
	]);
}

const READER: VelvePlugin<"reader"> = {
	id: "reader",
	hooks: {
		afterUserCreate: async (event, context) => {
			if (behaviour === "wait_for_every_sign_up_then_read") {
				await waitForEverySignUp();
			}
			const found = await context.repositories.findUserById({ userId: event.userId, actor: ACTOR });
			foundOnCreate.push(found?.id ?? null);
		},
	},
};

let connection: TestConnection;
let pool: Awaited<ReturnType<typeof openConnectionPool>>;
let schema: string;
let handler: (request: Request) => Promise<Response>;

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("signuppool"));
	pool = await openConnectionPool(POOL_SIZE, { acquireTimeoutMs: ACQUIRE_TIMEOUT_MS });
	handler = toWebHandler(
		createVelveAuth(
			configFor({
				database: pool,
				schema,
				plugins: [READER],
				rateLimit: {
					perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
					perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
				},
			}),
		),
	);
}, 120_000);

afterAll(async () => {
	await pool.close();
	await dropSchema(connection, schema);
	await connection.close();
});

beforeEach(() => {
	foundOnCreate.length = 0;
});

async function userIdOf(email: string): Promise<string | null> {
	const [row] = await connection.query<{ id: string }>(
		`SELECT id FROM ${schema}.user WHERE email = $1`,
		[email],
	);
	return row?.id ?? null;
}

describe("a sign-up's hooks reach a plugin as an after point promises (3.11, 3.15 G)", () => {
	it("lets afterUserCreate find the account it is told was created", async () => {
		behaviour = "find_the_created_account";
		const email = "signuppool-found@example.com";

		const answer = await handler(postTo("/sign-up", { email, password: PASSWORD }));

		expect(answer.status, await answer.clone().text()).toBe(200);
		expect(foundOnCreate).toStrictEqual([await userIdOf(email)]);
	}, 60_000);

	it("completes as many concurrent sign-ups as the pool has connections when the hook reads (E-2584)", async () => {
		behaviour = "wait_for_every_sign_up_then_read";

		const answers = await Promise.all(
			Array.from({ length: POOL_SIZE }, (_, index) =>
				handler(
					postTo("/sign-up", { email: `signuppool${index}@example.com`, password: PASSWORD }),
				),
			),
		);

		expect(answers.map((answer) => answer.status)).toStrictEqual(
			Array.from({ length: POOL_SIZE }, () => 200),
		);
	}, 120_000);
});
