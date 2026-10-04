import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
 * A reset whose revoke hook reads through its context must not wait on a connection that only
 * another reset can free (3.11, S-OWNER-12). As many resets as the pool has connections run at
 * once, and each hook waits until all of them have reached it before it reads, so every
 * connection is held by a reset at the moment the hooks ask for one. The pool gives up on a wait
 * after a bound, as `pg` does with `connectionTimeoutMillis`; without that bound the same run never
 * finishes, and every other request of the application waits behind it.
 */

const POOL_SIZE = 3;
const ACQUIRE_TIMEOUT_MS = 10_000;
const BARRIER_TIMEOUT_MS = 5_000;
const PASSWORD = "correct-horse-battery-staple";
const REPLACEMENT = "a different password entirely";
const ACTOR: PluginActor = { pluginId: "reader", reason: "the test reads the sessions" };

let arrived = 0;
let releaseBarrier: () => void = () => undefined;
const barrier = new Promise<void>((resolve) => {
	releaseBarrier = resolve;
});

function waitForEveryReset(): Promise<void> {
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
		beforeSessionRevoke: async (event, context) => {
			await waitForEveryReset();
			await context.repositories.listSessionsForUser({ userId: event.userId, actor: ACTOR });
		},
	},
};

let connection: TestConnection;
let pool: Awaited<ReturnType<typeof openConnectionPool>>;
let schema: string;
let handler: (request: Request) => Promise<Response>;
const mailed: EmailMessage[] = [];

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("revokepool"));
	pool = await openConnectionPool(POOL_SIZE, { acquireTimeoutMs: ACQUIRE_TIMEOUT_MS });
	handler = toWebHandler(
		createVelveAuth(
			configFor({
				database: pool,
				schema,
				email: {
					send: (message) => {
						mailed.push(message);
						return Promise.resolve();
					},
				},
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

async function resetTokenForNewAccount(index: number): Promise<string> {
	const email = `revokepool${index}@example.com`;
	const signedUp = await handler(postTo("/sign-up", { email, password: PASSWORD }));
	expect(signedUp.status).toBe(200);
	const requested = await handler(postTo("/password/request-reset", { email }));
	expect(requested.status).toBe(204);
	const message = mailed.find((sent) => sent.kind === "password_reset" && sent.to === email);
	if (message === undefined || message.kind !== "password_reset") {
		throw new Error("no reset message was sent");
	}
	return message.token;
}

describe("a revoke hook that reads does not starve the pool under concurrent resets (3.11)", () => {
	it("completes as many concurrent resets as the pool has connections", async () => {
		const tokens: string[] = [];
		for (let index = 0; index < POOL_SIZE; index += 1) {
			tokens.push(await resetTokenForNewAccount(index));
		}

		const answers = await Promise.all(
			tokens.map((token) =>
				handler(postTo("/password/redeem-reset", { token, newPassword: REPLACEMENT })),
			),
		);

		expect(answers.map((answer) => answer.status)).toStrictEqual(
			Array.from({ length: POOL_SIZE }, () => 200),
		);
	}, 120_000);
});
