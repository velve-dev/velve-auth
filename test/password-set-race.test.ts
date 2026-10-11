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
 * Two `password.set` calls on one account, each on its own connection. `password.set` refuses an
 * account that already has a credential, and a credential change revokes every other session
 * (S-FIX-6), so of two calls the second to reach the account row must find either a credential or
 * its own session gone. Run one after the other, the second is refused; run interleaved, it must be
 * refused the same way.
 *
 * The interleaving is chosen, not raced for: the first call is held just before it takes the
 * account row — after its precondition was read and its hash derived — and the second call is run to
 * completion before the first is released. That is the widest window two real requests can open,
 * and a request delayed by its KDF opens it on every run.
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
	const migrated = await openMigratedSchema("passwordsetrace");
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

let accounts = 0;

interface Account {
	readonly email: string;
	readonly userId: string;
	readonly tokens: readonly [string, string];
}

async function magicLinkTokenFor(email: string): Promise<string> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const message = outbox.find((each) => each.kind === "magic_link" && each.to === email);
		if (message !== undefined && "token" in message) {
			return message.token;
		}
		if (Date.now() > deadline) {
			throw new Error(`no magic link reached ${email}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** An account with no password and two live sessions, so a set may come from either. */
async function passwordlessAccountWithTwoSessions(): Promise<Account> {
	accounts += 1;
	const email = `set-race-${accounts}@example.com`;
	const signedUp = await post(second, "/sign-up/passwordless", { email });
	expect(signedUp.status).toBe(200);
	const { user } = (await signedUp.clone().json()) as { user: { id: string } };

	expect((await post(second, "/sign-in/magic-link/request", { email })).status).toBeLessThan(300);
	const redeemed = await post(second, "/sign-in/magic-link/redeem", {
		token: await magicLinkTokenFor(email),
	});
	expect(redeemed.status).toBe(200);

	return { email, userId: user.id, tokens: [sessionTokenOf(signedUp), sessionTokenOf(redeemed)] };
}

/** An account with a password and two live sessions, for the change that shares the set's write. */
async function accountWithPasswordAndTwoSessions(password: string): Promise<Account> {
	accounts += 1;
	const email = `change-race-${accounts}@example.com`;
	const signedUp = await post(second, "/sign-up", { email, password });
	expect(signedUp.status).toBe(200);
	const { user } = (await signedUp.clone().json()) as { user: { id: string } };
	const signedIn = await post(second, "/sign-in/password", { email, password });
	expect(signedIn.status).toBe(200);
	return { email, userId: user.id, tokens: [sessionTokenOf(signedUp), sessionTokenOf(signedIn)] };
}

/** First takes the account row only after second has finished; both have passed their checks. */
async function interleave(
	one: () => Promise<Response>,
	other: () => Promise<Response>,
): Promise<[Response, Response]> {
	const reached = held.holdBefore(/FOR NO KEY UPDATE/);
	const running = one();
	await reached;
	const finished = await other();
	held.release();
	return [await running, finished];
}

async function credentialRowsOf(userId: string): Promise<{ set_by_session_id: string | null }[]> {
	return observer.query(
		`SELECT set_by_session_id FROM ${schema}.password_credential WHERE user_id = $1`,
		[userId],
	);
}

async function sessionIdsOf(userId: string): Promise<string[]> {
	const rows = await observer.query<{ id: string }>(
		`SELECT id FROM ${schema}.session WHERE user_id = $1`,
		[userId],
	);
	return rows.map((row) => row.id);
}

async function resolves(token: string): Promise<boolean> {
	return (await observing.session.resolve({ origin: TEST_ORIGIN, sessionToken: token })) !== null;
}

async function signsIn(email: string, password: string): Promise<boolean> {
	const answer = await post(second, "/sign-in/password", { email, password });
	return answer.status === 200;
}

interface Outcome {
	readonly winner: { readonly answer: Response; readonly password: string };
	readonly loser: { readonly answer: Response; readonly password: string; readonly token: string };
}

function outcomeOf(
	answers: readonly [Response, Response],
	passwords: readonly [string, string],
	tokens: readonly [string, string],
): Outcome {
	const succeeded = answers.map((answer) => answer.status === 200);
	expect(succeeded.filter(Boolean), "exactly one of the two calls succeeds").toHaveLength(1);
	const won = succeeded[0] ? 0 : 1;
	const lost = 1 - won;
	return {
		winner: { answer: answers[won] as Response, password: passwords[won] as string },
		loser: {
			answer: answers[lost] as Response,
			password: passwords[lost] as string,
			token: tokens[lost] as string,
		},
	};
}

const REFUSALS_OF_A_LOSING_SET = ["session_required", "factor_already_enrolled"];

async function expectOnlyTheWinnerHolds(
	account: Account,
	outcome: Outcome,
	refusals: readonly string[] = REFUSALS_OF_A_LOSING_SET,
) {
	const { winner, loser } = outcome;
	expect(refusals).toContain(await errorCodeOf(loser.answer));
	expect(loser.answer.headers.getSetCookie().join("\n")).not.toMatch(
		new RegExp(`${DEFAULT_COOKIE_NAMES.session}=[^;]`),
	);

	const winnerToken = sessionTokenOf(winner.answer);
	const { session } = (await winner.answer.clone().json()) as { session: { id: string } };
	const credential = await credentialRowsOf(account.userId);
	expect(credential, "one credential, recorded as set by the winner's session (E-626)").toEqual([
		{ set_by_session_id: session.id },
	]);
	expect(await sessionIdsOf(account.userId), "the winner's session is the only one").toEqual([
		session.id,
	]);
	expect(await resolves(winnerToken), "the winner's reissued session stays valid").toBe(true);
	expect(await resolves(loser.token), "the loser's session was revoked (S-FIX-6)").toBe(false);

	expect(await signsIn(account.email, winner.password), "the winner's password holds").toBe(true);
	expect(await signsIn(account.email, loser.password), "the loser's password was never set").toBe(
		false,
	);
}

describe("two password.set calls on one account (3.15 B.4, S-FIX-6)", () => {
	it("lets one of two sets from two sessions win and refuses the other", async () => {
		const account = await passwordlessAccountWithTwoSessions();
		const passwords = [drawTestPassword(), drawTestPassword()] as const;

		const answers = await interleave(
			() => post(first, "/password/set", { newPassword: passwords[0] }, account.tokens[0]),
			() => post(second, "/password/set", { newPassword: passwords[1] }, account.tokens[1]),
		);

		await expectOnlyTheWinnerHolds(account, outcomeOf(answers, passwords, account.tokens));
	}, 60_000);

	it("lets one of two sets from the same session win and refuses the other", async () => {
		const account = await passwordlessAccountWithTwoSessions();
		const passwords = [drawTestPassword(), drawTestPassword()] as const;
		const token = account.tokens[0];

		const answers = await interleave(
			() => post(first, "/password/set", { newPassword: passwords[0] }, token),
			() => post(second, "/password/set", { newPassword: passwords[1] }, token),
		);

		await expectOnlyTheWinnerHolds(account, outcomeOf(answers, passwords, [token, token]));
	}, 60_000);

	it("refuses the second of two sets that run without interleaving", async () => {
		const account = await passwordlessAccountWithTwoSessions();
		const passwords = [drawTestPassword(), drawTestPassword()] as const;

		const earlier = await post(
			second,
			"/password/set",
			{ newPassword: passwords[1] },
			account.tokens[1],
		);
		const later = await post(
			first,
			"/password/set",
			{ newPassword: passwords[0] },
			account.tokens[0],
		);

		await expectOnlyTheWinnerHolds(account, outcomeOf([later, earlier], passwords, account.tokens));
	}, 60_000);
});

/**
 * `password.change` reaches the same transaction through `replacePasswordOfSession`, and its
 * precondition — the current password — is verified before the lock in the same way. The loser
 * verified a password that the winner has since replaced.
 */
describe("two password.change calls on one account (S-FIX-6)", () => {
	it("lets one of two changes from two sessions win and refuses the other", async () => {
		const current = drawTestPassword();
		const account = await accountWithPasswordAndTwoSessions(current);
		const passwords = [drawTestPassword(), drawTestPassword()] as const;

		const answers = await interleave(
			() =>
				post(
					first,
					"/password/change",
					{ currentPassword: current, newPassword: passwords[0] },
					account.tokens[0],
				),
			() =>
				post(
					second,
					"/password/change",
					{ currentPassword: current, newPassword: passwords[1] },
					account.tokens[1],
				),
		);

		await expectOnlyTheWinnerHolds(account, outcomeOf(answers, passwords, account.tokens), [
			"session_required",
			"invalid_credentials",
		]);
		expect(await signsIn(account.email, current), "the replaced password stops working").toBe(
			false,
		);
	}, 60_000);
});
