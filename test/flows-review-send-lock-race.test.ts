import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { VelveAuthConfig } from "../src/core/auth/config.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createVelveAuth } from "../src/index.js";
import { TEST_ORIGIN, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

const OWNER = "held@example.com";
/** Long enough that a lock-free path finishes inside it by orders of magnitude, short enough to run. */
const WHILE_THE_SEND_IS_HELD_MS = 400;

let mailing: TestConnection;
let bystander: TestConnection;
let schema: string;
let handler: (request: Request) => Promise<Response>;
let releaseTheSend: () => void = () => undefined;

function handlerOn(connection: TestConnection, send: () => Promise<void>) {
	const auth = createVelveAuth({
		identity: { mode: "email" },
		database: connection,
		schema,
		keys: testKeyProvider(),
		origins: [TEST_ORIGIN],
		rateLimit: {
			perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
			perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
		},
		email: { send },
	} as VelveAuthConfig<"email">);
	return toWebHandler(auth);
}

function post(path: string, body: unknown): Promise<Response> {
	return handler(
		new Request(`https://api.example.com${path}`, {
			method: "POST",
			headers: { Origin: TEST_ORIGIN, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

beforeAll(async () => {
	const migrated = await openMigratedSchema("sendlock");
	schema = migrated.schema;
	mailing = migrated.connection;
	bystander = await openTestConnection();
	handler = handlerOn(mailing, () => Promise.resolve());
	await post("/sign-up", { email: OWNER, password: "a password long enough" });
	handler = handlerOn(
		mailing,
		() =>
			new Promise<void>((resolve) => {
				releaseTheSend = resolve;
			}),
	);
}, 60_000);

afterAll(async () => {
	await dropSchema(mailing, schema);
	await mailing.close();
	await bystander.close();
});

/**
 * CLAUDE.md §7 on what a row lock costs: "while it is held, every write of a user-owned row for that
 * account waits, and if the transaction contains an outbound call the wait is that call's timeout."
 * A.7 requires the artefact to roll back when `send` throws, so the send is inside a transaction;
 * E-600 puts it inside the `SELECT … FOR UPDATE` on `velve.user` that minting takes as well. This
 * pins what that costs rather than asserting it away, because closing it is a change to where the
 * lock is taken and not to this feature (E-621).
 */
describe("the send callback runs while the account's row lock is held", () => {
	it("makes a concurrent write of the account's row wait for the mail callback", async () => {
		const [account] = await bystander.query<{ id: string }>(
			`SELECT id FROM ${schema}.user WHERE email = $1`,
			[OWNER],
		);
		const requesting = post("/password/request-reset", { email: OWNER });
		await new Promise((resolve) => setTimeout(resolve, WHILE_THE_SEND_IS_HELD_MS));

		let bystanderFinished = false;
		const writing = bystander
			.query(`UPDATE ${schema}.user SET updated_at = now() WHERE id = $1`, [account?.id])
			.then(() => {
				bystanderFinished = true;
			});
		await new Promise((resolve) => setTimeout(resolve, WHILE_THE_SEND_IS_HELD_MS));
		const blockedWhileHeld = !bystanderFinished;

		releaseTheSend();
		await requesting;
		await writing;

		expect(blockedWhileHeld).toBe(true);
		expect(bystanderFinished).toBe(true);
	}, 60_000);
});
