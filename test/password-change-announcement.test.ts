import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import type { SessionRevokeEvent, VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, TEST_ORIGIN, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { HeldDriver } from "./lock-order-fixtures.js";
import { drawTestPassword } from "./password-fixtures.js";

/**
 * `password.set` and `password.change` announce the sessions they delete to `beforeSessionRevoke`
 * as `password_changed` (3.11, 3.15 G). E-2702 left the announcement before the account lock, so a
 * call that E-2701 then refused had already announced revocations that never happened, and the call
 * that won announced the same sessions again. E-2705 moves the announcement under the lock.
 *
 * Each case holds the first call just before `FOR NO KEY UPDATE` and runs the other request to
 * completion on a second connection before releasing it, as `test/password-set-race.test.ts` does
 * (E-2703). Both library instances carry the same recording plugin.
 */

type Handler = (request: Request) => Promise<Response>;

const announced: SessionRevokeEvent[] = [];

const RECORDER: VelvePlugin<"recorder"> = {
	id: "recorder",
	hooks: {
		beforeSessionRevoke: (event) => {
			announced.push(event);
			return Promise.resolve();
		},
	},
};

let schema: string;
let observer: TestConnection;
let firstConnection: TestConnection;
let secondConnection: TestConnection;
let held: HeldDriver;
let first: Handler;
let second: Handler;
const keys = testKeyProvider();

function handlerOn(database: Driver): Handler {
	return toWebHandler(
		createVelveAuth(
			configFor({
				database,
				schema,
				keys,
				plugins: [RECORDER],
				rateLimit: {
					perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
					perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
				},
			}),
		),
	);
}

beforeAll(async () => {
	const migrated = await openMigratedSchema("pwchangeannounce");
	schema = migrated.schema;
	observer = migrated.connection;
	firstConnection = await openTestConnection();
	secondConnection = await openTestConnection();
	held = new HeldDriver(firstConnection);
	first = handlerOn(held);
	second = handlerOn(secondConnection);
}, 120_000);

afterAll(async () => {
	await dropSchema(observer, schema);
	await Promise.all([observer.close(), firstConnection.close(), secondConnection.close()]);
});

beforeEach(() => {
	announced.length = 0;
});

function post(handler: Handler, path: string, body: unknown, token?: string): Promise<Response> {
	return handler(
		new Request(`https://api.example.com${path}`, {
			method: "POST",
			headers: {
				Origin: TEST_ORIGIN,
				"Content-Type": "application/json",
				...(token === undefined ? {} : { Cookie: `${DEFAULT_COOKIE_NAMES.session}=${token}` }),
			},
			body: JSON.stringify(body),
		}),
	);
}

function sessionTokenOf(answer: Response): string {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === DEFAULT_COOKIE_NAMES.session && separator < pair.length - 1) {
			return pair.slice(separator + 1);
		}
	}
	throw new Error(`the answer (${answer.status}) carried no session cookie`);
}

let accounts = 0;

interface Account {
	readonly email: string;
	readonly userId: string;
	readonly password: string;
	readonly token: string;
}

async function accountWithPassword(): Promise<Account> {
	accounts += 1;
	const email = `announce-${accounts}@example.com`;
	const password = drawTestPassword();
	const signedUp = await post(second, "/sign-up", { email, password });
	expect(signedUp.status).toBe(200);
	const { user } = (await signedUp.clone().json()) as { user: { id: string } };
	return { email, userId: user.id, password, token: sessionTokenOf(signedUp) };
}

async function signIn(account: Account): Promise<string> {
	const answer = await post(second, "/sign-in/password", {
		email: account.email,
		password: account.password,
	});
	expect(answer.status).toBe(200);
	return sessionTokenOf(answer);
}

async function sessionIdsOf(userId: string): Promise<string[]> {
	const rows = await observer.query<{ id: string }>(
		`SELECT id FROM ${schema}.session WHERE user_id = $1 ORDER BY id`,
		[userId],
	);
	return rows.map((row) => row.id);
}

function change(handler: Handler, account: Account, token: string): Promise<Response> {
	return post(
		handler,
		"/password/change",
		{ currentPassword: account.password, newPassword: drawTestPassword() },
		token,
	);
}

async function whileHeldBeforeTheLock<T>(
	heldCall: () => Promise<Response>,
	meanwhile: () => Promise<T>,
): Promise<[Response, T]> {
	const reached = held.holdBefore(/FOR NO KEY UPDATE/);
	const running = heldCall();
	await reached;
	const finished = await meanwhile();
	held.release();
	return [await running, finished];
}

function announcedIds(): string[] {
	return announced.map((event) => event.sessionId).sort();
}

describe("a credential change announces only what it deletes (E-2705)", () => {
	it("announces nothing for a change refused because a concurrent change won", async () => {
		const account = await accountWithPassword();
		const other = await signIn(account);
		const before = await sessionIdsOf(account.userId);
		expect(before).toHaveLength(2);

		const [heldAnswer, winnerAnswer] = await whileHeldBeforeTheLock(
			() => change(first, account, account.token),
			() => change(second, account, other),
		);

		expect(winnerAnswer.status).toBe(200);
		expect(heldAnswer.status).toBe(401);
		expect(announcedIds(), "each session the winner deleted, once").toStrictEqual(before);
		expect(announced.every((event) => event.reason === "password_changed")).toBe(true);
		expect(announced.every((event) => event.userId === account.userId)).toBe(true);
	}, 60_000);

	it("announces a session signed in while the change waited, and every session once", async () => {
		const account = await accountWithPassword();
		const [changeAnswer, signedIn] = await whileHeldBeforeTheLock(
			() => change(first, account, account.token),
			() => signIn(account),
		);
		expect(changeAnswer.status).toBe(200);
		expect(signedIn).not.toBe("");
		const { session } = (await changeAnswer.clone().json()) as { session: { id: string } };

		expect(announced).toHaveLength(2);
		expect(new Set(announcedIds()).size).toBe(2);
		expect(announcedIds()).not.toContain(session.id);
		expect(await sessionIdsOf(account.userId)).toStrictEqual([session.id]);
	}, 60_000);

	it("announces nothing for a session signed out while the change waited", async () => {
		const account = await accountWithPassword();
		const other = await signIn(account);
		expect(await sessionIdsOf(account.userId)).toHaveLength(2);

		const [changeAnswer, signedOut] = await whileHeldBeforeTheLock(
			() => change(first, account, account.token),
			() => post(second, "/sign-out", {}, other),
		);
		expect(signedOut.status).toBeLessThan(300);
		expect(changeAnswer.status).toBe(200);
		const changed = announced.filter((event) => event.reason === "password_changed");
		expect(changed, "only the caller's own session was left to delete").toHaveLength(1);
	}, 60_000);
});
