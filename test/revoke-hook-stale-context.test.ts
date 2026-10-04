import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import type { FrozenContext, PluginActor, VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { openConnectionPool } from "./connection-pool-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { postTo } from "./flows-fixtures.js";

/**
 * A reset lends its revoke hook a context bound to the reset's own connection (E-2584). Once the
 * hook has returned and the reset has committed, that connection goes back to the pool and serves
 * another request's transaction. A context the plugin kept must not reach into that transaction:
 * a revocation it reports as done would then commit or roll back with work the plugin never saw,
 * and a plugin statement's savepoint could undo that other transaction's own writes. Here the
 * pool has one connection, a transaction of the application's own holds it, and the kept context
 * revokes a session; the transaction rolls back, and the session must not be left standing behind
 * a revocation that answered as done.
 */

const PASSWORD = "correct-horse-battery-staple";
const REPLACEMENT = "a different password entirely";
const ACTOR: PluginActor = { pluginId: "keeper", reason: "the test keeps the context" };

let kept: FrozenContext | null = null;

const KEEPER: VelvePlugin<"keeper"> = {
	id: "keeper",
	hooks: {
		beforeSessionRevoke: async (_event, context) => {
			kept = context;
		},
	},
};

class RolledBackOnPurpose extends Error {}

let connection: TestConnection;
let pool: Awaited<ReturnType<typeof openConnectionPool>>;
let schema: string;
let handler: (request: Request) => Promise<Response>;
const mailed: EmailMessage[] = [];

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("revokestale"));
	pool = await openConnectionPool(1, { acquireTimeoutMs: 10_000 });
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
				plugins: [KEEPER],
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

async function sessionStands(sessionId: string): Promise<boolean> {
	const rows = await connection.query(`SELECT 1 FROM ${schema}.session WHERE id = $1`, [sessionId]);
	return rows.length === 1;
}

describe("a context lent to a reset's revoke hook does not outlive the reset (3.11, E-2584)", () => {
	it("never reports a revocation done inside a transaction that is not the reset's", async () => {
		const email = "revokestale@example.com";
		expect((await handler(postTo("/sign-up", { email, password: PASSWORD }))).status).toBe(200);
		expect((await handler(postTo("/password/request-reset", { email }))).status).toBe(204);
		const message = mailed.find((sent) => sent.kind === "password_reset");
		if (message === undefined || message.kind !== "password_reset") {
			throw new Error("no reset message was sent");
		}
		const reset = await handler(
			postTo("/password/redeem-reset", { token: message.token, newPassword: REPLACEMENT }),
		);
		expect(reset.status).toBe(200);
		const { session } = (await reset.json()) as { session: { id: string } };
		const context = kept;
		if (context === null) {
			throw new Error("the hook was not called");
		}

		const answered = await pool
			.transaction(async () => {
				const outcome = await context.repositories
					.revokeSession({ sessionId: session.id, reason: "revoked_by_user", actor: ACTOR })
					.then(
						() => "revoked" as const,
						() => "refused" as const,
					);
				throw new RolledBackOnPurpose(outcome);
			})
			.catch((error: unknown) => {
				if (error instanceof RolledBackOnPurpose) {
					return error.message;
				}
				throw error;
			});

		const reportedDoneYetStanding = answered === "revoked" && (await sessionStands(session.id));
		expect(reportedDoneYetStanding).toBe(false);
	}, 60_000);
});
