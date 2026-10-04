import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import type { PluginActor, SessionRevokeEvent, VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { configFor, TEST_ORIGIN } from "./auth-fixtures.js";
import { openConnectionPool } from "./connection-pool-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { postTo } from "./flows-fixtures.js";
import {
	codeCarrying,
	createStubProvider,
	oauthConfigFor,
	type StubProvider,
} from "./oauth-provider.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";

/**
 * Every revocation a `RevokeReason` names reaches `beforeSessionRevoke` with that reason and with
 * the ids it removes (3.11, 3.15 G), and a hook that refuses one leaves the credential change it
 * belongs to undone as a whole (S-OWNER-12, S-RACE-5). The library is mounted over a pool, so a
 * hook that reads through its context while a reset holds the account row runs on a connection of
 * its own, as it does under a real driver.
 */

const PASSWORD = "correct-horse-battery-staple";
const REPLACEMENT = "a different password entirely";
const ONE_TOTP_STEP_IN_MILLISECONDS = 30_000;
const ACTOR: PluginActor = { pluginId: "recorder", reason: "the test reads the sessions" };

const announced: SessionRevokeEvent[] = [];
const standingWhenAnnounced: boolean[] = [];
let refuse = false;

const RECORDER: VelvePlugin<"recorder"> = {
	id: "recorder",
	hooks: {
		beforeSessionRevoke: async (event, context) => {
			announced.push(event);
			const standing = await context.repositories.listSessionsForUser({
				userId: event.userId,
				actor: ACTOR,
			});
			standingWhenAnnounced.push(standing.some((session) => session.id === event.sessionId));
			if (refuse) {
				throw new Error("the recorder refused the revocation");
			}
		},
	},
};

let connection: TestConnection;
let pool: Awaited<ReturnType<typeof openConnectionPool>>;
let schema: string;
let handler: (request: Request) => Promise<Response>;
let clock: TestClock;
let provider: StubProvider;
const mailed: EmailMessage[] = [];

function send(message: EmailMessage): Promise<void> {
	mailed.push(message);
	return Promise.resolve();
}

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("revokehook"));
	pool = await openConnectionPool(4);
	clock = createTestClock();
	provider = await createStubProvider({
		claims: { sub: "unused", email: "unused@example.com", email_verified: true },
	});
	const auth = createVelveAuth(
		configFor({
			database: pool,
			schema,
			clock,
			email: { send },
			plugins: [RECORDER],
			oauth: oauthConfigFor({ openIdConnect: false }),
			fetch: provider.fetch,
			rateLimit: {
				perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
				perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
			},
		}),
	);
	handler = toWebHandler(auth);
}, 120_000);

afterAll(async () => {
	await pool.close();
	await dropSchema(connection, schema);
	await connection.close();
});

beforeEach(() => {
	announced.length = 0;
	standingWhenAnnounced.length = 0;
	refuse = false;
});

function cookieIn(answer: Response, name: string): string | null {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === name) {
			const value = pair.slice(separator + 1);
			return value === "" ? null : value;
		}
	}
	return null;
}

function sessionCookieOf(answer: Response): string {
	const token = cookieIn(answer, DEFAULT_COOKIE_NAMES.session);
	if (token === null) {
		throw new Error(`the answer (${answer.status}) wrote no session cookie`);
	}
	return token;
}

function withSession(token: string): { Cookie: string } {
	return { Cookie: `${DEFAULT_COOKIE_NAMES.session}=${token}` };
}

let accounts = 0;

interface Account {
	readonly email: string;
	readonly userId: string;
	readonly calling: string;
}

/** An account with two sessions: the one sign-up issued, and a second from a later sign-in. */
async function accountWithTwoSessions(): Promise<Account> {
	accounts += 1;
	const address = `revokehook${accounts}@example.com`;
	const signedUp = await handler(postTo("/sign-up", { email: address, password: PASSWORD }));
	expect(signedUp.status).toBe(200);
	const signedIn = await handler(
		postTo("/sign-in/password", { email: address, password: PASSWORD }),
	);
	expect(signedIn.status).toBe(200);
	const [row] = await connection.query<{ id: string }>(
		`SELECT id FROM ${schema}.user WHERE email = $1`,
		[address],
	);
	return { email: address, userId: row?.id ?? "", calling: sessionCookieOf(signedUp) };
}

async function sessionIdsOf(userId: string): Promise<string[]> {
	const rows = await connection.query<{ id: string }>(
		`SELECT id FROM ${schema}.session WHERE user_id = $1 ORDER BY id`,
		[userId],
	);
	return rows.map((row) => row.id);
}

async function passwordRowOf(userId: string): Promise<string> {
	const [row] = await connection.query<{ phc: Buffer }>(
		`SELECT phc FROM ${schema}.password_credential WHERE user_id = $1`,
		[userId],
	);
	return row?.phc.toString("hex") ?? "";
}

async function signsInWith(address: string, password: string): Promise<boolean> {
	const answer = await handler(postTo("/sign-in/password", { email: address, password }));
	return answer.status === 200;
}

function eventsFor(userId: string, ids: readonly string[], reason: SessionRevokeEvent["reason"]) {
	return [...ids].sort().map((sessionId) => ({ sessionId, userId, reason }));
}

function sortedAnnouncements(): SessionRevokeEvent[] {
	return [...announced].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

async function resetTokenFor(address: string): Promise<string> {
	mailed.length = 0;
	const requested = await handler(postTo("/password/request-reset", { email: address }));
	expect(requested.status).toBe(204);
	const message = mailed.find((sent) => sent.kind === "password_reset");
	if (message === undefined || message.kind !== "password_reset") {
		throw new Error("no reset message was sent");
	}
	return message.token;
}

async function recoveryCodeFor(account: Account): Promise<string> {
	const started = await handler(
		postTo("/factor/totp/enroll/start", {}, withSession(account.calling)),
	);
	const { secretBase32 } = (await started.json()) as { secretBase32: string };
	const finished = await handler(
		postTo(
			"/factor/totp/enroll/finish",
			{ code: totpCodeForStep(secretBytesOfBase32(secretBase32), timeStepAt(clock.now())) },
			withSession(account.calling),
		),
	);
	expect([started.status, finished.status]).toStrictEqual([200, 204]);
	clock.advanceBy(2 * ONE_TOTP_STEP_IN_MILLISECONDS);
	const generated = await handler(
		postTo("/factor/recovery/generate", {}, withSession(account.calling)),
	);
	const { codes } = (await generated.json()) as { codes: readonly string[] };
	return codes[0] ?? "";
}

let subjects = 0;

async function linkCallback(account: Account): Promise<Response> {
	subjects += 1;
	provider.reportClaims({
		sub: `revokehook-subject-${subjects}`,
		email: `provider${subjects}@elsewhere.example`,
		email_verified: true,
	});
	const started = await handler(
		postTo("/identity/link/start", { provider: "stubby" }, withSession(account.calling)),
	);
	expect(started.status, await started.clone().text()).toBe(200);
	const body = (await started.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string };
	};
	const state = new URL(body.authorizationUrl).searchParams.get("state") ?? "";
	return handler(
		new Request(
			`https://api.example.com/sign-in/oauth/callback/stubby?code=${codeCarrying(null)}&state=${encodeURIComponent(state)}`,
			{
				headers: {
					Origin: TEST_ORIGIN,
					Cookie: `${DEFAULT_COOKIE_NAMES.oauthState}=${body.stateCookie.value}; ${DEFAULT_COOKIE_NAMES.session}=${account.calling}`,
				},
			},
		),
	);
}

async function identityCountOf(userId: string): Promise<number> {
	const [row] = await connection.query<{ count: number }>(
		`SELECT count(*)::int AS count FROM ${schema}.identity WHERE user_id = $1`,
		[userId],
	);
	return row?.count ?? -1;
}

async function sessionIdOfToken(token: string): Promise<string> {
	const resolved = await handler(
		new Request("https://api.example.com/session", {
			headers: { Origin: TEST_ORIGIN, ...withSession(token) },
		}),
	);
	const body = (await resolved.json()) as { session: { id: string } } | null;
	return body?.session.id ?? "";
}

describe("every revocation a RevokeReason names is announced with that reason (3.11, 3.15 G)", () => {
	it("announces every session a password change removes as password_changed", async () => {
		const account = await accountWithTwoSessions();
		const before = await sessionIdsOf(account.userId);
		expect(before).toHaveLength(2);

		const answer = await handler(
			postTo(
				"/password/change",
				{ currentPassword: PASSWORD, newPassword: REPLACEMENT },
				withSession(account.calling),
			),
		);

		expect(answer.status, await answer.clone().text()).toBe(200);
		expect(sortedAnnouncements()).toStrictEqual(
			eventsFor(account.userId, before, "password_changed"),
		);
		expect(standingWhenAnnounced).toStrictEqual([true, true]);
	}, 60_000);

	it("announces every session a first password set removes as password_changed", async () => {
		accounts += 1;
		const address = `revokehookset${accounts}@example.com`;
		const signedUp = await handler(postTo("/sign-up/passwordless", { email: address }));
		expect(signedUp.status, await signedUp.clone().text()).toBe(200);
		const token = sessionCookieOf(signedUp);
		const [row] = await connection.query<{ id: string }>(
			`SELECT id FROM ${schema}.user WHERE email = $1`,
			[address],
		);
		const userId = row?.id ?? "";
		const before = await sessionIdsOf(userId);

		const answer = await handler(
			postTo("/password/set", { newPassword: REPLACEMENT }, withSession(token)),
		);

		expect(answer.status, await answer.clone().text()).toBe(200);
		expect(sortedAnnouncements()).toStrictEqual(eventsFor(userId, before, "password_changed"));
	}, 60_000);

	it("announces every session a reset by mailed token removes as password_reset", async () => {
		const account = await accountWithTwoSessions();
		const before = await sessionIdsOf(account.userId);
		const token = await resetTokenFor(account.email);

		const answer = await handler(
			postTo("/password/redeem-reset", { token, newPassword: REPLACEMENT }),
		);

		expect(answer.status, await answer.clone().text()).toBe(200);
		expect(sortedAnnouncements()).toStrictEqual(
			eventsFor(account.userId, before, "password_reset"),
		);
		expect(standingWhenAnnounced).toStrictEqual([true, true]);
	}, 60_000);

	it("announces every session a reset by recovery code removes as password_reset", async () => {
		const account = await accountWithTwoSessions();
		const code = await recoveryCodeFor(account);
		const before = await sessionIdsOf(account.userId);
		announced.length = 0;

		const answer = await handler(
			postTo("/password/redeem-reset-with-recovery-code", {
				email: account.email,
				recoveryCode: code,
				newPassword: REPLACEMENT,
			}),
		);

		expect(answer.status, await answer.clone().text()).toBe(200);
		expect(sortedAnnouncements()).toStrictEqual(
			eventsFor(account.userId, before, "password_reset"),
		);
	}, 60_000);

	it("announces the one session an identity link replaces as identity_linked", async () => {
		const account = await accountWithTwoSessions();
		const linking = await sessionIdOfToken(account.calling);
		announced.length = 0;

		const answer = await linkCallback(account);

		expect(answer.status, await answer.clone().text()).toBeLessThan(400);
		expect(announced).toStrictEqual([
			{ sessionId: linking, userId: account.userId, reason: "identity_linked" },
		]);
	}, 60_000);
});

describe("a refused revocation leaves the credential change undone as a whole (S-OWNER-12, S-RACE-5)", () => {
	it("leaves the password and every session where they were when the hook refuses a change", async () => {
		const account = await accountWithTwoSessions();
		const sessionsBefore = await sessionIdsOf(account.userId);
		const passwordBefore = await passwordRowOf(account.userId);
		refuse = true;

		const answer = await handler(
			postTo(
				"/password/change",
				{ currentPassword: PASSWORD, newPassword: REPLACEMENT },
				withSession(account.calling),
			),
		);
		refuse = false;

		expect(answer.status).toBe(500);
		expect(cookieIn(answer, DEFAULT_COOKIE_NAMES.session)).toBeNull();
		expect(await sessionIdsOf(account.userId)).toStrictEqual(sessionsBefore);
		expect(await passwordRowOf(account.userId)).toBe(passwordBefore);
		expect(await signsInWith(account.email, REPLACEMENT)).toBe(false);
	}, 60_000);

	it("leaves the password, the sessions and the token where they were when the hook refuses a reset", async () => {
		const account = await accountWithTwoSessions();
		const token = await resetTokenFor(account.email);
		const sessionsBefore = await sessionIdsOf(account.userId);
		const passwordBefore = await passwordRowOf(account.userId);
		refuse = true;

		const refused = await handler(
			postTo("/password/redeem-reset", { token, newPassword: REPLACEMENT }),
		);
		refuse = false;

		expect(refused.status).toBe(500);
		expect(await sessionIdsOf(account.userId)).toStrictEqual(sessionsBefore);
		expect(await passwordRowOf(account.userId)).toBe(passwordBefore);
		const redeemedLater = await handler(
			postTo("/password/redeem-reset", { token, newPassword: REPLACEMENT }),
		);
		expect(redeemedLater.status).toBe(200);
	}, 60_000);

	it("leaves the password, the sessions and the code where they were when the hook refuses a recovery reset", async () => {
		const account = await accountWithTwoSessions();
		const code = await recoveryCodeFor(account);
		const sessionsBefore = await sessionIdsOf(account.userId);
		const passwordBefore = await passwordRowOf(account.userId);
		const input = { email: account.email, recoveryCode: code, newPassword: REPLACEMENT };
		refuse = true;

		const refused = await handler(postTo("/password/redeem-reset-with-recovery-code", input));
		refuse = false;

		expect(refused.status).toBe(500);
		expect(await sessionIdsOf(account.userId)).toStrictEqual(sessionsBefore);
		expect(await passwordRowOf(account.userId)).toBe(passwordBefore);
		const redeemedLater = await handler(postTo("/password/redeem-reset-with-recovery-code", input));
		expect(redeemedLater.status).toBe(200);
	}, 60_000);

	it("links no identity and replaces no session when the hook refuses a link", async () => {
		const account = await accountWithTwoSessions();
		const sessionsBefore = await sessionIdsOf(account.userId);
		refuse = true;

		const refused = await linkCallback(account);
		refuse = false;

		expect(refused.status).toBeGreaterThanOrEqual(400);
		expect(await sessionIdsOf(account.userId)).toStrictEqual(sessionsBefore);
		expect(await identityCountOf(account.userId)).toBe(0);
	}, 60_000);
});
