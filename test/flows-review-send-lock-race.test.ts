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
 * This case measured that cost while `send` ran inside the minting transaction, and the finding is
 * what moved the call: the transaction now commits and the lock goes before the application's
 * callback is entered, and a `send` that throws is answered by spending the token rather than by
 * rolling it back (E-630). What it pins now is the absence — a bystanding write of the account's row
 * completes while the callback is still held, and the control below shows the case can still fail.
 */
describe("the send callback runs after the account's row lock has gone", () => {
	it("lets a concurrent write of the account's row through while the mail callback is held", async () => {
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
		const finishedWhileTheSendWasHeld = bystanderFinished;

		releaseTheSend();
		await requesting;
		await writing;

		expect(finishedWhileTheSendWasHeld).toBe(true);
	}, 60_000);

	/**
	 * The control the case needs to be worth anything: a transaction on the mailing connection that
	 * holds the same row lock over the same wait does block the bystander, so the expectation above
	 * measures where the callback runs and not whether the probe can detect a lock at all.
	 */
	it("blocks the same write when the row lock really is held across the wait", async () => {
		const [account] = await bystander.query<{ id: string }>(
			`SELECT id FROM ${schema}.user WHERE email = $1`,
			[OWNER],
		);
		let bystanderFinished = false;
		let releaseTheLock: () => void = () => undefined;
		const holding = mailing.transaction(async (transaction) => {
			await transaction.query(
				`SELECT id FROM ${schema}.user WHERE id = $1 FOR UPDATE /* locks: ${schema}.user */`,
				[account?.id],
			);
			await new Promise<void>((resolve) => {
				releaseTheLock = resolve;
			});
		});
		// The lock has to be taken before the bystander asks for the row, or the two race and the
		// control measures whichever won.
		await new Promise((resolve) => setTimeout(resolve, WHILE_THE_SEND_IS_HELD_MS));

		const writing = bystander
			.query(`UPDATE ${schema}.user SET updated_at = now() WHERE id = $1`, [account?.id])
			.then(() => {
				bystanderFinished = true;
			});
		await new Promise((resolve) => setTimeout(resolve, WHILE_THE_SEND_IS_HELD_MS));
		const finishedWhileTheLockWasHeld = bystanderFinished;

		releaseTheLock();
		await holding;
		await writing;

		expect(finishedWhileTheLockWasHeld).toBe(false);
		expect(bystanderFinished).toBe(true);
	}, 60_000);
});
