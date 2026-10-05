import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import type { Driver } from "../src/core/db/driver.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createVelveAuth, type VelveAuth } from "../src/index.js";
import { configFor, TEST_ORIGIN, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { HeldDriver } from "./lock-order-fixtures.js";
import { drawTestPassword } from "./password-fixtures.js";

/**
 * `password.set` and `password.change` read their precondition and the account's session list
 * before their transaction opens, and E-2701 makes the transaction refuse a call whose own session
 * a concurrent credential change revoked. `test/password-set-race.test.ts` drives that only against
 * a second set or change; E-2700 says the resets were reasoned from the code and not driven.
 *
 * This file drives the writers E-2701 relies on — a mailed reset against a held set and a held
 * change — and the result field both routes return: `revokedOtherSessionsCount` is the number of
 * sessions the change revoked besides the caller's (3.15 B.4, DOCUMENTATION.md `SetPasswordResult`),
 * so a session signed in or signed out while the call waits for the account row has to be counted
 * as it stands under the lock, the way both resets already count it.
 *
 * Each case holds the first call just before `FOR NO KEY UPDATE` — after its precondition, its
 * derivation and its session listing — and runs the other request to completion before releasing it.
 */

type Handler = (request: Request) => Promise<Response>;

let schema: string;
let observer: TestConnection;
let firstConnection: TestConnection;
let secondConnection: TestConnection;
let held: HeldDriver;
let first: Handler;
let second: Handler;
let observing: VelveAuth<"email">;
const outbox: EmailMessage[] = [];
const keys = testKeyProvider();

function authOn(database: Driver): VelveAuth<"email"> {
	return createVelveAuth(
		configFor({
			database,
			schema,
			keys,
			// The interleaving is the subject; a bucket that refuses a request would measure itself.
			rateLimit: {
				perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
				perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
			},
			email: {
				send: (message) => {
					outbox.push(message);
					return Promise.resolve();
				},
			},
		}),
	);
}

beforeAll(async () => {
	const migrated = await openMigratedSchema("pwconcurrentwriters");
	schema = migrated.schema;
	observer = migrated.connection;
	firstConnection = await openTestConnection();
	secondConnection = await openTestConnection();
	held = new HeldDriver(firstConnection);
	first = toWebHandler(authOn(held));
	second = toWebHandler(authOn(secondConnection));
	observing = authOn(observer);
}, 120_000);

afterAll(async () => {
	await dropSchema(observer, schema);
	await Promise.all([observer.close(), firstConnection.close(), secondConnection.close()]);
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

async function errorCodeOf(answer: Response): Promise<string> {
	return ((await answer.clone().json()) as { error?: { code?: string } }).error?.code ?? "";
}

async function mailedTokenFor(kind: EmailMessage["kind"], email: string): Promise<string> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const message = outbox.find((each) => each.kind === kind && each.to === email);
		if (message !== undefined && "token" in message) {
			return message.token;
		}
		if (Date.now() > deadline) {
			throw new Error(`no ${kind} message reached ${email}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

let accounts = 0;

function nextEmail(prefix: string): string {
	accounts += 1;
	return `${prefix}-${accounts}@example.com`;
}

interface Account {
	readonly email: string;
	readonly userId: string;
	readonly token: string;
}

async function passwordlessAccount(): Promise<Account> {
	const email = nextEmail("writers-set");
	const signedUp = await post(second, "/sign-up/passwordless", { email });
	expect(signedUp.status).toBe(200);
	const { user } = (await signedUp.clone().json()) as { user: { id: string } };
	return { email, userId: user.id, token: sessionTokenOf(signedUp) };
}

async function accountWithPassword(password: string): Promise<Account> {
	const email = nextEmail("writers-change");
	const signedUp = await post(second, "/sign-up", { email, password });
	expect(signedUp.status).toBe(200);
	const { user } = (await signedUp.clone().json()) as { user: { id: string } };
	return { email, userId: user.id, token: sessionTokenOf(signedUp) };
}

async function signIn(email: string, password: string): Promise<Response> {
	return post(second, "/sign-in/password", { email, password });
}

async function signsIn(email: string, password: string): Promise<boolean> {
	return (await signIn(email, password)).status === 200;
}

async function resolves(token: string): Promise<boolean> {
	return (await observing.session.resolve({ origin: TEST_ORIGIN, sessionToken: token })) !== null;
}

async function credentialRowsOf(userId: string): Promise<{ set_by_session_id: string | null }[]> {
	return observer.query(
		`SELECT set_by_session_id FROM ${schema}.password_credential WHERE user_id = $1`,
		[userId],
	);
}

/** Runs `held` up to the account lock, then `meanwhile` to completion, then lets `held` go on. */
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

async function resetTo(email: string, password: string): Promise<Response> {
	expect((await post(second, "/password/request-reset", { email })).status).toBeLessThan(300);
	return post(second, "/password/redeem-reset", {
		token: await mailedTokenFor("password_reset", email),
		newPassword: password,
	});
}

describe("a mailed reset committing while a set or change waits for the account row (E-2701)", () => {
	it("refuses the held set, so set never replaces the password the reset stored (3.15 B.4)", async () => {
		const account = await passwordlessAccount();
		const setTo = drawTestPassword();
		const resetPassword = drawTestPassword();

		const [setAnswer, resetAnswer] = await whileHeldBeforeTheLock(
			() => post(first, "/password/set", { newPassword: setTo }, account.token),
			() => resetTo(account.email, resetPassword),
		);

		expect(resetAnswer.status).toBe(200);
		expect(setAnswer.status).toBe(401);
		expect(await errorCodeOf(setAnswer)).toBe("session_required");
		const { session } = (await resetAnswer.clone().json()) as { session: { id: string } };
		expect(await credentialRowsOf(account.userId)).toEqual([{ set_by_session_id: session.id }]);
		expect(await signsIn(account.email, resetPassword), "the reset's password holds").toBe(true);
		expect(await signsIn(account.email, setTo), "the refused set wrote nothing").toBe(false);
		expect(await resolves(account.token), "the set's session was revoked by the reset").toBe(false);
	}, 60_000);

	it("refuses the held change, so the reset's password is not lost (S-FIX-6)", async () => {
		const current = drawTestPassword();
		const account = await accountWithPassword(current);
		const changeTo = drawTestPassword();
		const resetPassword = drawTestPassword();

		const [changeAnswer, resetAnswer] = await whileHeldBeforeTheLock(
			() =>
				post(
					first,
					"/password/change",
					{ currentPassword: current, newPassword: changeTo },
					account.token,
				),
			() => resetTo(account.email, resetPassword),
		);

		expect(resetAnswer.status).toBe(200);
		expect(changeAnswer.status).toBe(401);
		expect(await errorCodeOf(changeAnswer)).toBe("session_required");
		expect(await signsIn(account.email, resetPassword), "the reset's password holds").toBe(true);
		expect(await signsIn(account.email, changeTo), "the refused change wrote nothing").toBe(false);
		expect(await resolves(account.token)).toBe(false);
	}, 60_000);
});

describe("a session revoked without a credential change while a change waits (E-2701)", () => {
	it("refuses the change and leaves every other session standing", async () => {
		const current = drawTestPassword();
		const account = await accountWithPassword(current);
		const other = sessionTokenOf(await signIn(account.email, current));
		const changeTo = drawTestPassword();

		const [changeAnswer, signOut] = await whileHeldBeforeTheLock(
			() =>
				post(
					first,
					"/password/change",
					{ currentPassword: current, newPassword: changeTo },
					account.token,
				),
			() => post(second, "/sign-out", {}, account.token),
		);

		expect(signOut.status).toBeLessThan(300);
		expect(changeAnswer.status).toBe(401);
		expect(await errorCodeOf(changeAnswer)).toBe("session_required");
		expect(await resolves(other), "nothing revoked the other session").toBe(true);
		expect(await signsIn(account.email, current), "the password is unchanged").toBe(true);
	}, 60_000);
});

describe("revokedOtherSessionsCount is the number of other sessions the change revoked (3.15 B.4)", () => {
	it("counts a session signed in while the change waited for the account row", async () => {
		const current = drawTestPassword();
		const account = await accountWithPassword(current);
		const changeTo = drawTestPassword();

		const [changeAnswer, signedIn] = await whileHeldBeforeTheLock(
			() =>
				post(
					first,
					"/password/change",
					{ currentPassword: current, newPassword: changeTo },
					account.token,
				),
			() => signIn(account.email, current),
		);

		expect(signedIn.status).toBe(200);
		expect(changeAnswer.status).toBe(200);
		expect(await resolves(sessionTokenOf(signedIn)), "the change revoked it (S-FIX-6)").toBe(false);
		const result = (await changeAnswer.clone().json()) as { revokedOtherSessionsCount: number };
		expect(result.revokedOtherSessionsCount, "one other session was revoked").toBe(1);
	}, 60_000);

	it("does not count a session signed out while the change waited for the account row", async () => {
		const current = drawTestPassword();
		const account = await accountWithPassword(current);
		const other = sessionTokenOf(await signIn(account.email, current));
		const changeTo = drawTestPassword();

		const [changeAnswer, signOut] = await whileHeldBeforeTheLock(
			() =>
				post(
					first,
					"/password/change",
					{ currentPassword: current, newPassword: changeTo },
					account.token,
				),
			() => post(second, "/sign-out", {}, other),
		);

		expect(signOut.status).toBeLessThan(300);
		expect(changeAnswer.status).toBe(200);
		const result = (await changeAnswer.clone().json()) as { revokedOtherSessionsCount: number };
		expect(result.revokedOtherSessionsCount, "the change revoked no other session").toBe(0);
	}, 60_000);
});
