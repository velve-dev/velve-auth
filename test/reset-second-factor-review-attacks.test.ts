import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import type { Driver } from "../src/core/db/driver.js";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import type { VelvePlugin } from "../src/core/plugin/config.js";
import type { SecurityStateAlarm } from "../src/core/security-state/alarm.js";
import {
	createVelveAuth,
	registerPluginErrorCodes,
	type VelveAuth,
	VelveError,
} from "../src/index.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { configFor, createLogSink, type LogSink, TEST_ORIGIN } from "./auth-fixtures.js";
import { openConnectionPool } from "./connection-pool-fixtures.js";
import { dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { difference, postTo } from "./flows-fixtures.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";

/**
 * Review of S-FIX-7 and S-FIX-8 against the requirement "the mailed reset asks for an enrolled
 * second factor", written from the specification and not from the writer's tests. Each case is an
 * attacker the requirement implies: the mailbox without the factor, the factor without the
 * mailbox, a writer of the database moving a row between accounts, two completions at once, a
 * check spent once and presented again, a pending reset overtaken by a later one, the only
 * factor removed while the reset waits, and a plugin refusing a revocation.
 */

const POOL_SIZE = 8;
const PASSWORD = "correct-horse-battery-staple";
const REPLACEMENT = "a different password entirely";
const ANOTHER = "yet another password of some length";
const RESET_ROUTE = "/password/redeem-reset";
const ONE_TOTP_STEP = 30_000;
const PENDING_REMOVAL = /^\s*DELETE FROM \S*pending_authentication\b/;
const REFUSED = { httpStatus: 403, message: "Refused by the review spy." } as const;

interface Interception {
	act: (() => Promise<void>) | null;
}

const interception: Interception = { act: null };

//a change runs on another connection just before the completion removes its pending row
function changingTheAccountBeforeTheCompletion(inner: Driver): Driver {
	return {
		async query<T>(sql: string, params: unknown[]): Promise<T[]> {
			const act = interception.act;
			if (act !== null && PENDING_REMOVAL.test(sql)) {
				interception.act = null;
				await act();
			}
			return inner.query<T>(sql, params);
		},
		transaction<T>(work: (tx: Driver) => Promise<T>): Promise<T> {
			return inner.transaction((tx) => work(changingTheAccountBeforeTheCompletion(tx)));
		},
	};
}

interface Fired {
	readonly point: string;
	readonly event: unknown;
}

const fired: Fired[] = [];
let refuseAtBeforeSessionRevoke = false;

function at(point: string) {
	return (event: object): Promise<void> => {
		fired.push({ point, event });
		return point === "beforeSessionRevoke" && refuseAtBeforeSessionRevoke
			? Promise.reject(new VelveError("reviewspy.refused"))
			: Promise.resolve();
	};
}

const SPY: VelvePlugin<"reviewspy"> = {
	id: "reviewspy",
	hooks: {
		beforeSignIn: at("beforeSignIn"),
		afterSignIn: at("afterSignIn"),
		beforeSessionCreate: at("beforeSessionCreate"),
		afterSessionCreate: at("afterSessionCreate"),
		beforeSessionRevoke: at("beforeSessionRevoke"),
	},
};

const sent: EmailMessage[] = [];
const alarms: SecurityStateAlarm[] = [];
const bodies: string[] = [];
let migrated: MigratedSchema;
let pool: Awaited<ReturnType<typeof openConnectionPool>>;
let auth: VelveAuth<"email">;
let rawHandler: (request: Request) => Promise<Response>;
let clock: TestClock;
let log: LogSink;
let accounts = 0;

//every answer body is kept so the clear-text case can search what left the library
async function handler(request: Request): Promise<Response> {
	const answer = await rawHandler(request);
	bodies.push(await answer.clone().text());
	return answer;
}

beforeAll(async () => {
	registerPluginErrorCodes({ "reviewspy.refused": REFUSED });
	clock = createTestClock(new Date());
	log = createLogSink();
	migrated = await openMigratedSchema("reset_factor_review");
	pool = await openConnectionPool(POOL_SIZE);
	auth = createVelveAuth(
		configFor({
			database: changingTheAccountBeforeTheCompletion(pool),
			schema: migrated.schema,
			clock,
			log: log.write,
			plugins: [SPY],
			email: {
				send: (message) => {
					sent.push(message);
					return Promise.resolve();
				},
			},
			securityState: { sealing: "required", alarm: (alarm) => alarms.push(alarm) },
			rateLimit: {
				perIpAddress: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
				perAccount: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
			},
		}),
	);
	rawHandler = toWebHandler(auth);
}, 60_000);

afterAll(async () => {
	await pool.close();
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

beforeEach(() => {
	alarms.length = 0;
	fired.length = 0;
	interception.act = null;
	refuseAtBeforeSessionRevoke = false;
});

function cookieIn(answer: Response, name: string): string | null {
	for (const header of answer.headers.getSetCookie()) {
		const [pair = ""] = header.split(";");
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

interface Account {
	readonly email: string;
	readonly userId: string;
	readonly sessionToken: string;
}

async function signUp(): Promise<Account> {
	accounts += 1;
	const email = `reset-review-${accounts}@example.com`;
	const answer = await handler(postTo("/sign-up", { email, password: PASSWORD }));
	const sessionToken = cookieIn(answer, DEFAULT_COOKIE_NAMES.session);
	const body = (await answer.json()) as { user: { id: string } };
	if (answer.status !== 200 || sessionToken === null) {
		throw new Error(`the sign-up answered ${answer.status} without a session`);
	}
	return { email, userId: body.user.id, sessionToken };
}

function codeAt(secret: string, stepOffset = 0): string {
	return totpCodeForStep(secretBytesOfBase32(secret), timeStepAt(clock.now()) + stepOffset);
}

function nextStep(): void {
	clock.advanceBy(ONE_TOTP_STEP);
}

async function enrolTotp(account: Account): Promise<string> {
	const started = await handler(
		postTo("/factor/totp/enroll/start", {}, withSession(account.sessionToken)),
	);
	const { secretBase32 } = (await started.json()) as { secretBase32: string };
	const finished = await handler(
		postTo(
			"/factor/totp/enroll/finish",
			{ code: codeAt(secretBase32) },
			withSession(account.sessionToken),
		),
	);
	expect([started.status, finished.status]).toStrictEqual([200, 204]);
	nextStep();
	return secretBase32;
}

async function generateRecoveryCodes(account: Account): Promise<readonly string[]> {
	const answer = await handler(
		postTo("/factor/recovery/generate", {}, withSession(account.sessionToken)),
	);
	expect(answer.status).toBe(200);
	return ((await answer.json()) as { codes: readonly string[] }).codes;
}

async function resetTokenFor(email: string): Promise<string> {
	sent.length = 0;
	const requested = await handler(postTo("/password/request-reset", { email }));
	expect(requested.status).toBe(204);
	const message = sent.find((each) => each.kind === "password_reset");
	if (message === undefined || message.kind !== "password_reset") {
		throw new Error("no reset message was sent");
	}
	return message.token;
}

async function redeemHeldBack(email: string, newPassword = REPLACEMENT): Promise<string> {
	const token = await resetTokenFor(email);
	const answer = await handler(postTo(RESET_ROUTE, { token, newPassword }));
	const pendingToken = cookieIn(answer, DEFAULT_COOKIE_NAMES.pending);
	expect(answer.status).toBe(200);
	if (pendingToken === null) {
		throw new Error("the held back reset set no pending cookie");
	}
	return pendingToken;
}

async function answerOf(answer: Response): Promise<string> {
	const body = (await answer.clone().json()) as {
		status?: string;
		error?: { code: string };
	};
	return `${answer.status} ${body.error?.code ?? body.status ?? "no status"}`;
}

async function signInStatus(email: string, password: string): Promise<string> {
	return answerOf(await handler(postTo("/sign-in/password", { email, password })));
}

function verifyTotp(pendingToken: string, code: string): Promise<Response> {
	return handler(postTo("/factor/totp/verify", { code }, withPending(pendingToken)));
}

function verifyRecovery(pendingToken: string, code: string | undefined): Promise<Response> {
	return handler(postTo("/factor/recovery/verify", { code }, withPending(pendingToken)));
}

async function sessionsOf(userId: string): Promise<number> {
	const [row] = await migrated.connection.query<{ total: number }>(
		`SELECT count(*)::integer AS total FROM ${migrated.schema}.session WHERE user_id = $1`,
		[userId],
	);
	return row?.total ?? -1;
}

async function pendingRowsOf(userId: string): Promise<number> {
	const [row] = await migrated.connection.query<{ total: number }>(
		`SELECT count(*)::integer AS total FROM ${migrated.schema}.pending_authentication
		WHERE user_id = $1`,
		[userId],
	);
	return row?.total ?? -1;
}

async function sessionResolves(sessionToken: string): Promise<boolean> {
	const answer = await handler(
		new Request("https://api.example.com/session", {
			headers: { Origin: TEST_ORIGIN, ...withSession(sessionToken) },
		}),
	);
	return answer.status === 200 && (await answer.json()) !== null;
}

describe("the factor without the mailbox", () => {
	it("leaves redeemResetWithRecoveryCode as it was on an account with TOTP: no status, no pending row", async () => {
		const account = await signUp();
		await enrolTotp(account);
		const codes = await generateRecoveryCodes(account);

		const answer = await handler(
			postTo("/password/redeem-reset-with-recovery-code", {
				email: account.email,
				recoveryCode: codes[0],
				newPassword: REPLACEMENT,
			}),
		);
		const body = (await answer.json()) as Record<string, unknown>;

		expect(answer.status).toBe(200);
		expect(Object.keys(body).sort()).toStrictEqual(["revokedOtherSessionsCount", "session"]);
		expect(cookieIn(answer, DEFAULT_COOKIE_NAMES.pending)).toBeNull();
		expect(cookieIn(answer, DEFAULT_COOKIE_NAMES.session)).not.toBeNull();
		expect(await pendingRowsOf(account.userId)).toBe(0);
		expect(await sessionResolves(account.sessionToken)).toBe(false);
		expect(await signInStatus(account.email, REPLACEMENT)).toBe("200 second_factor_required");
	});

	it("refuses a writer who moves their own pending reset onto the victim and completes it with the victim's TOTP", async () => {
		const attacker = await signUp();
		await generateRecoveryCodes(attacker);
		const victim = await signUp();
		const victimSecret = await enrolTotp(victim);
		const pendingToken = await redeemHeldBack(attacker.email, ANOTHER);
		await migrated.connection.query(
			`UPDATE ${migrated.schema}.pending_authentication SET user_id = $2 WHERE user_id = $1`,
			[attacker.userId, victim.userId],
		);

		const refused = await verifyTotp(pendingToken, codeAt(victimSecret));

		expect(await answerOf(refused)).toBe("401 invalid_pending_authentication");
		expect(cookieIn(refused, DEFAULT_COOKIE_NAMES.session)).toBeNull();
		expect(await sessionResolves(victim.sessionToken)).toBe(true);
		expect(await signInStatus(victim.email, PASSWORD)).toBe("200 second_factor_required");
		expect(await signInStatus(victim.email, ANOTHER)).toBe("401 invalid_credentials");
		expect(alarms.map((alarm) => alarm.reason)).toContain("token_binding_mismatch");
	});
});

describe("the mailbox without the factor", () => {
	it("shares one budget of five across TOTP and recovery codes and writes nothing on the way", async () => {
		const account = await signUp();
		await enrolTotp(account);
		const codes = await generateRecoveryCodes(account);
		const pendingToken = await redeemHeldBack(account.email);
		fired.length = 0;

		const answers = [
			await answerOf(await verifyTotp(pendingToken, "000000")),
			await answerOf(await verifyRecovery(pendingToken, "AAAA-AAAA-AAAA-AAAA")),
			await answerOf(await verifyTotp(pendingToken, "111111")),
			await answerOf(await verifyRecovery(pendingToken, "BBBB-BBBB-BBBB-BBBB")),
			await answerOf(await verifyTotp(pendingToken, "222222")),
			await answerOf(await verifyRecovery(pendingToken, codes[0])),
		];

		expect(answers).toStrictEqual([
			"401 invalid_factor_code",
			"401 invalid_recovery_code",
			"401 invalid_factor_code",
			"401 invalid_recovery_code",
			"429 too_many_factor_attempts",
			"401 invalid_pending_authentication",
		]);
		expect(await sessionResolves(account.sessionToken)).toBe(true);
		expect(await sessionsOf(account.userId)).toBe(1);
		expect(await signInStatus(account.email, REPLACEMENT)).toBe("401 invalid_credentials");
		expect(fired.filter((each) => each.point.includes("Session"))).toStrictEqual([]);
	});

	it("answers an expired reset token of an account with a factor exactly as an invented one", async () => {
		const account = await signUp();
		await enrolTotp(account);
		const token = await resetTokenFor(account.email);
		await migrated.connection.query(
			`UPDATE ${migrated.schema}.one_time_token SET expires_at = now() - interval '1 second'
			WHERE user_id = $1 AND purpose = 'password_reset'`,
			[account.userId],
		);

		const expired = await handler(postTo(RESET_ROUTE, { token, newPassword: REPLACEMENT }));
		const invented = await handler(
			postTo(RESET_ROUTE, { token: "an-invented-token-of-the-review", newPassword: REPLACEMENT }),
		);

		expect(expired.status).toBe(400);
		expect(await difference(expired, invented)).toStrictEqual([]);
		expect(await pendingRowsOf(account.userId)).toBe(0);
	});
});

describe("a check is spent once (S-FIX-8)", () => {
	it("lets at most one of two completions with the same TOTP code at the same time write", async () => {
		const account = await signUp();
		const secret = await enrolTotp(account);
		const pendingToken = await redeemHeldBack(account.email);
		const code = codeAt(secret);

		const answers = await Promise.all([
			verifyTotp(pendingToken, code),
			verifyTotp(pendingToken, code),
		]);
		const won = answers.filter((answer) => answer.status === 200).length;

		// S-FIX-8 says at most one; a replay racing the right code may cost both, as at a sign-in.
		expect(won).toBeLessThanOrEqual(1);
		expect(await sessionsOf(account.userId)).toBe(1);
		expect(await sessionResolves(account.sessionToken)).toBe(won === 0);
		expect(await signInStatus(account.email, won === 1 ? REPLACEMENT : PASSWORD)).toBe(
			"200 second_factor_required",
		);
		expect(await signInStatus(account.email, won === 1 ? PASSWORD : REPLACEMENT)).toBe(
			"401 invalid_credentials",
		);
	});

	it("does not take the same code again after a refused completion, and completes with the next one", async () => {
		const account = await signUp();
		const secret = await enrolTotp(account);
		const pendingToken = await redeemHeldBack(account.email);
		interception.act = async () => {
			await auth.factor.recovery.generate({
				sessionToken: account.sessionToken,
				origin: TEST_ORIGIN,
			});
		};
		const code = codeAt(secret);

		const refused = await verifyTotp(pendingToken, code);
		const replayed = await verifyTotp(pendingToken, code);
		const unchanged = await signInStatus(account.email, PASSWORD);
		nextStep();
		const completed = await verifyTotp(pendingToken, codeAt(secret));

		expect(await answerOf(refused)).toBe("401 invalid_factor_code");
		expect(await answerOf(replayed)).toBe("401 invalid_factor_code");
		expect(unchanged).toBe("200 second_factor_required");
		expect(await answerOf(completed)).toBe("200 signed_in");
		expect(await signInStatus(account.email, REPLACEMENT)).toBe("200 second_factor_required");
	});
});

describe("no stale password is written", () => {
	it("refuses the older of two pending resets once the newer one completed", async () => {
		const account = await signUp();
		const secret = await enrolTotp(account);
		const older = await redeemHeldBack(account.email, ANOTHER);
		const newer = await redeemHeldBack(account.email, REPLACEMENT);

		const completed = await verifyTotp(newer, codeAt(secret));
		nextStep();
		const stale = await verifyTotp(older, codeAt(secret));

		expect(await answerOf(completed)).toBe("200 signed_in");
		expect(await answerOf(stale)).toBe("401 invalid_pending_authentication");
		expect(await signInStatus(account.email, REPLACEMENT)).toBe("200 second_factor_required");
		expect(await signInStatus(account.email, ANOTHER)).toBe("401 invalid_credentials");
		expect(await sessionsOf(account.userId)).toBe(1);
	});

	it("writes no password once the only factor was removed while the reset waited", async () => {
		const account = await signUp();
		const secret = await enrolTotp(account);
		const pendingToken = await redeemHeldBack(account.email);
		const removed = await handler(
			postTo("/factor/totp/remove", { code: codeAt(secret) }, withSession(account.sessionToken)),
		);
		nextStep();

		const refused = await verifyTotp(pendingToken, codeAt(secret));

		expect(removed.status).toBe(204);
		expect(refused.status).not.toBe(200);
		expect(cookieIn(refused, DEFAULT_COOKIE_NAMES.session)).toBeNull();
		expect(await sessionResolves(account.sessionToken)).toBe(true);
		expect(await signInStatus(account.email, PASSWORD)).toBe("200 signed_in");
	});
});

describe("plugins at the completion (3.11)", () => {
	it("leaves password, sessions and the pending row when beforeSessionRevoke refuses", async () => {
		const account = await signUp();
		const secret = await enrolTotp(account);
		const pendingToken = await redeemHeldBack(account.email);
		refuseAtBeforeSessionRevoke = true;
		fired.length = 0;

		const refused = await verifyTotp(pendingToken, codeAt(secret));

		expect(refused.status).toBe(403);
		expect(fired.map((each) => each.point)).toStrictEqual([
			"beforeSessionCreate",
			"beforeSessionRevoke",
		]);
		expect(await sessionResolves(account.sessionToken)).toBe(true);
		expect(await pendingRowsOf(account.userId)).toBe(1);
		expect(await sessionsOf(account.userId)).toBe(1);
		expect(await signInStatus(account.email, PASSWORD)).toBe("200 second_factor_required");
	});

	it("runs the session points only when the server method completes the reset, not at its redemption", async () => {
		const account = await signUp();
		const secret = await enrolTotp(account);
		const token = await resetTokenFor(account.email);
		fired.length = 0;

		const held = await auth.password.redeemReset({
			token,
			newPassword: REPLACEMENT,
			origin: TEST_ORIGIN,
		});
		const atRedemption = fired.map((each) => each.point);
		if (held.status !== "second_factor_required") {
			throw new Error(`the reset answered ${held.status}`);
		}
		const completed = await auth.factor.totp.verify({
			code: codeAt(secret),
			pendingToken: held.pendingToken,
			origin: TEST_ORIGIN,
		});

		expect(atRedemption).toStrictEqual([]);
		expect(held.pending.availableFactors).toStrictEqual(["totp"]);
		expect(completed.status).toBe("signed_in");
		expect(fired.map((each) => each.point)).toStrictEqual([
			"beforeSessionCreate",
			"beforeSessionRevoke",
			"afterSessionCreate",
		]);
		expect(await sessionResolves(account.sessionToken)).toBe(false);
		expect(await signInStatus(account.email, REPLACEMENT)).toBe("200 second_factor_required");
	});
});

describe("the new password in clear text", () => {
	it("appears in no answer, log line, alarm or plugin event over a refused and a completed reset", async () => {
		const secretPassword = "the review's own password nobody may see";
		const account = await signUp();
		const secret = await enrolTotp(account);
		bodies.length = 0;
		const logged = log.lines.length;
		const pendingToken = await redeemHeldBack(account.email, secretPassword);
		await verifyTotp(pendingToken, "000000");
		const completed = await verifyTotp(pendingToken, codeAt(secret));
		const [row] = await migrated.connection.query<{ phc: Uint8Array | null }>(
			`SELECT phc FROM ${migrated.schema}.password_credential WHERE user_id = $1`,
			[account.userId],
		);

		const seen = JSON.stringify([
			bodies,
			log.lines.slice(logged),
			alarms,
			fired.map((each) => each.event),
		]);
		expect(await answerOf(completed)).toBe("200 signed_in");
		expect(seen.includes(secretPassword)).toBe(false);
		expect(seen.includes("$argon2id$")).toBe(false);
		expect(Buffer.from(row?.phc ?? new Uint8Array(0)).includes(Buffer.from("$argon2id$"))).toBe(
			false,
		);
		expect(await signInStatus(account.email, secretPassword)).toBe("200 second_factor_required");
	});
});
