import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import type { SecurityStateAlarm } from "../src/core/security-state/alarm.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";

/**
 * Section 3.18, point 3: a writer without the root key keeps an old row with its MAC and writes it
 * back later. A pending authentication written back after four failed codes, a session revoked on
 * its own, a session whose deadline was moved by SQL and a consumed reset or address-verification
 * link are each refused as a missing row would be, because the state their MAC binds has moved on
 * under the seal.
 */

const PASSWORD = "correct-horse-battery-staple";
const ONE_TOTP_STEP_IN_MILLISECONDS = 30_000;

let mounted: MountedAuth;
let clock: TestClock;
let alarms: SecurityStateAlarm[];
let accounts = 0;

beforeAll(async () => {
	clock = createTestClock();
	alarms = [];
	mounted = await mountAuth("row_replay", {
		clock,
		securityState: { sealing: "required", alarm: (event) => alarms.push(event) },
		rateLimit: {
			perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
			perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
		},
	});
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
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

function withSession(token: string): Record<string, string> {
	return { Cookie: `${DEFAULT_COOKIE_NAMES.session}=${token}` };
}

function withPending(token: string): Record<string, string> {
	return { Cookie: `${DEFAULT_COOKIE_NAMES.pending}=${token}` };
}

async function codeOf(answer: Response): Promise<string | undefined> {
	return ((await answer.json()) as { error?: { code?: string } }).error?.code;
}

async function signUp(): Promise<{ email: string; userId: string; sessionToken: string }> {
	accounts += 1;
	const email = `replay${accounts}@example.com`;
	const answer = await mounted.handler(postTo("/sign-up", { email, password: PASSWORD }));
	const body = (await answer.json()) as { user: { id: string } };
	const sessionToken = cookieIn(answer, DEFAULT_COOKIE_NAMES.session);
	if (answer.status !== 200 || sessionToken === null) {
		throw new Error(`the sign-up answered ${answer.status} without a session`);
	}
	return { email, userId: body.user.id, sessionToken };
}

async function signIn(email: string): Promise<Response> {
	return mounted.handler(postTo("/sign-in/password", { email, password: PASSWORD }));
}

async function sessionsOf(userId: string): Promise<string[]> {
	const rows = await mounted.connection.query<{ id: string }>(
		`SELECT id FROM ${mounted.schema}.session WHERE user_id = $1 ORDER BY created_at, id`,
		[userId],
	);
	return rows.map((row) => row.id);
}

/** the row as the writer keeps it, every column and its MAC included */
async function savedRow(table: string, where: string, parameters: unknown[]): Promise<string> {
	const [row] = await mounted.connection.query<{ saved: string }>(
		`SELECT to_jsonb(t)::text AS saved FROM ${mounted.schema}.${table} t WHERE ${where}`,
		parameters,
	);
	if (row === undefined) {
		throw new Error(`no ${table} row to save`);
	}
	return row.saved;
}

async function writtenBack(table: string, saved: string, key: string): Promise<void> {
	const value = (JSON.parse(saved) as Record<string, unknown>)[key];
	await mounted.connection.query(
		`DELETE FROM ${mounted.schema}.${table} WHERE ${key} = (SELECT ${key} FROM jsonb_populate_record(NULL::${mounted.schema}.${table}, $1::jsonb))`,
		[saved],
	);
	await mounted.connection.query(
		`INSERT INTO ${mounted.schema}.${table}
		 SELECT * FROM jsonb_populate_record(NULL::${mounted.schema}.${table}, $1::jsonb)`,
		[saved],
	);
	expect(value).toBeDefined();
}

async function resolvedSession(token: string): Promise<unknown> {
	const answer = await mounted.handler(
		requestTo("/session", { method: "GET", cookie: `${DEFAULT_COOKIE_NAMES.session}=${token}` }),
	);
	return answer.status === 200 ? answer.json() : null;
}

async function alarmsDelivered(): Promise<SecurityStateAlarm[]> {
	await new Promise((resolve) => setTimeout(resolve, 50));
	return alarms;
}

function alarmsFor(userId: string): SecurityStateAlarm[] {
	return alarms.filter((alarm) => alarm.userId === userId);
}

async function expectOneAlarm(userId: string, occasion: string): Promise<void> {
	await alarmsDelivered();
	expect(alarmsFor(userId).map((alarm) => `${alarm.occasion} ${alarm.reason}`)).toStrictEqual([
		`${occasion} token_binding_mismatch`,
	]);
}

function tokenMailed(kind: string, to: string): string {
	const message = mounted.email.messages
		.filter((candidate) => candidate.kind === kind && candidate.to === to)
		.at(-1);
	if (message === undefined || !("token" in message)) {
		throw new Error(`no ${kind} message carrying a token`);
	}
	return message.token;
}

describe("a pending authentication written back after four failed codes (section 3.18 point 3)", () => {
	it("refuses the fifth attempt, the right code included, and raises the alarm", async () => {
		const account = await signUp();
		const started = await mounted.handler(
			postTo("/factor/totp/enroll/start", {}, withSession(account.sessionToken)),
		);
		const { secretBase32 } = (await started.json()) as { secretBase32: string };
		const codeNow = () =>
			totpCodeForStep(secretBytesOfBase32(secretBase32), timeStepAt(clock.now()));
		await mounted.handler(
			postTo("/factor/totp/enroll/finish", { code: codeNow() }, withSession(account.sessionToken)),
		);
		clock.advanceBy(2 * ONE_TOTP_STEP_IN_MILLISECONDS);
		const pendingToken = cookieIn(await signIn(account.email), DEFAULT_COOKIE_NAMES.pending);
		if (pendingToken === null) {
			throw new Error("the sign-in reached no intermediate state");
		}
		const saved = await savedRow("pending_authentication", "user_id = $1", [account.userId]);
		const wrong = codeNow() === "000000" ? "111111" : "000000";
		for (let attempt = 0; attempt < 4; attempt += 1) {
			const failed = await mounted.handler(
				postTo("/factor/totp/verify", { code: wrong }, withPending(pendingToken)),
			);
			expect(await codeOf(failed)).toBe("invalid_factor_code");
		}
		await alarmsDelivered();
		const before = alarmsFor(account.userId).length;

		await writtenBack("pending_authentication", saved, "token_sha256");
		const fifth = await mounted.handler(
			postTo("/factor/totp/verify", { code: codeNow() }, withPending(pendingToken)),
		);

		expect(`${fifth.status} ${await codeOf(fifth)}`).toBe("401 invalid_pending_authentication");
		expect(cookieIn(fifth, DEFAULT_COOKIE_NAMES.session)).toBeNull();
		await alarmsDelivered();
		expect(
			alarmsFor(account.userId)
				.slice(before)
				.map((alarm) => `${alarm.occasion} ${alarm.reason}`),
		).toStrictEqual(["factor_check token_binding_mismatch"]);
	});
});

describe("a session revoked on its own and written back (section 3.18 point 3)", () => {
	it("refuses a session revoked by another session of the account", async () => {
		const account = await signUp();
		const second = cookieIn(await signIn(account.email), DEFAULT_COOKIE_NAMES.session);
		const [, secondId] = await sessionsOf(account.userId);
		if (second === null || secondId === undefined) {
			throw new Error("the second sign-in issued no session");
		}
		const saved = await savedRow("session", "id = $1", [secondId]);

		const revoked = await mounted.handler(
			postTo("/session/revoke", { targetSessionId: secondId }, withSession(account.sessionToken)),
		);
		expect(revoked.status).toBe(204);
		await writtenBack("session", saved, "id");

		expect(await resolvedSession(second)).toBeNull();
		expect(await resolvedSession(account.sessionToken)).not.toBeNull();
		await expectOneAlarm(account.userId, "session_resolve");
	});

	it("refuses a session that signed out", async () => {
		const account = await signUp();
		const second = cookieIn(await signIn(account.email), DEFAULT_COOKIE_NAMES.session);
		const [, secondId] = await sessionsOf(account.userId);
		if (second === null || secondId === undefined) {
			throw new Error("the second sign-in issued no session");
		}
		const saved = await savedRow("session", "id = $1", [secondId]);

		await mounted.handler(postTo("/sign-out", {}, withSession(second)));
		await writtenBack("session", saved, "id");

		expect(await resolvedSession(second)).toBeNull();
		expect(await resolvedSession(account.sessionToken)).not.toBeNull();
		await expectOneAlarm(account.userId, "session_resolve");
	});
});

describe("a session deadline moved by SQL (section 3.18 point 3)", () => {
	it("refuses a session whose idle deadline was extended", async () => {
		const account = await signUp();
		await mounted.connection.query(
			`UPDATE ${mounted.schema}.session SET idle_expires_at = idle_expires_at + interval '1 day'
			 WHERE user_id = $1`,
			[account.userId],
		);

		expect(await resolvedSession(account.sessionToken)).toBeNull();
		await expectOneAlarm(account.userId, "session_resolve");
	});

	it("refuses a session whose absolute deadline was extended", async () => {
		const account = await signUp();
		await mounted.connection.query(
			`UPDATE ${mounted.schema}.session
			 SET absolute_expires_at = absolute_expires_at + interval '1 day' WHERE user_id = $1`,
			[account.userId],
		);

		expect(await resolvedSession(account.sessionToken)).toBeNull();
		await expectOneAlarm(account.userId, "session_resolve");
	});

	it("keeps a session the library itself extended", async () => {
		const account = await signUp();
		clock.advanceBy(60_000);
		const refreshed = await mounted.handler(
			postTo("/session/refresh", {}, withSession(account.sessionToken)),
		);

		expect(refreshed.status).toBe(200);
		expect(await resolvedSession(account.sessionToken)).not.toBeNull();
	});
});

describe("a consumed one-time token written back (section 3.18 point 3)", () => {
	it("refuses a password reset link redeemed once already", async () => {
		const account = await signUp();
		await mounted.handler(postTo("/password/request-reset", { email: account.email }));
		const token = tokenMailed("password_reset", account.email);
		const saved = await savedRow("one_time_token", "user_id = $1 AND purpose = 'password_reset'", [
			account.userId,
		]);
		const first = await mounted.handler(
			postTo("/password/redeem-reset", { token, newPassword: "a-first-new-password-here" }),
		);
		expect(first.status).toBe(200);

		await writtenBack("one_time_token", saved, "token_sha256");
		const second = await mounted.handler(
			postTo("/password/redeem-reset", { token, newPassword: "the-writers-own-password" }),
		);

		expect(`${second.status} ${await codeOf(second)}`).toBe("400 invalid_token");
		await expectOneAlarm(account.userId, "token_redemption");
	});

	it("refuses an address verification link redeemed once already", async () => {
		const account = await signUp();
		const token = tokenMailed("email_verification", account.email);
		const saved = await savedRow("one_time_token", "user_id = $1 AND purpose = 'email_verify'", [
			account.userId,
		]);
		const first = await mounted.handler(postTo("/email/redeem-verification", { token }));
		expect(first.status).toBeLessThan(300);

		await writtenBack("one_time_token", saved, "token_sha256");
		const second = await mounted.handler(postTo("/email/redeem-verification", { token }));

		expect(`${second.status} ${await codeOf(second)}`).toBe("400 invalid_token");
		await expectOneAlarm(account.userId, "token_redemption");
	});
});
