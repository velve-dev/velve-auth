import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import type { SecurityStateAlarm } from "../src/core/security-state/alarm.js";
import { encodeSecurityState } from "../src/core/security-state/encoding.js";
import {
	checkSecurityState,
	readSecurityState,
	securityStateOf,
} from "../src/core/security-state/read.js";
import { computeSeal } from "../src/core/security-state/seal.js";
import { createVelveAuth, type VelveAuth, VelveError } from "../src/index.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import {
	configFor,
	type MountedAuth,
	mountAuth,
	requestTo,
	TEST_ORIGIN,
	testKeyProvider,
} from "./auth-fixtures.js";
import { openConnectionPool } from "./connection-pool-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";
import { createVirtualAuthenticator } from "./webauthn-simulator.js";

/**
 * S-INTEG-11 and T-INTEG-11: the no-recovery switch is a component of the seal, changed only by
 * `user.disableRecovery` and `user.enableRecovery` under the account lock. Turning it on deletes
 * the recovery codes and retires every reset and magic link of the account in the same sealing
 * transaction, keeps the epoch and every session, and is logged with the account id and no
 * address. A writer without the root key who clears or sets the column breaks the state, and an
 * account that never turns the switch on keeps the encoding it had before migration 6.
 */

const PASSWORD = "correct-horse-battery-staple";
const REPLACEMENT = "a different password entirely";
const ONE_TOTP_STEP_IN_MILLISECONDS = 30_000;
const RELYING_PARTY_ID = "app.example.com";
const TURNED_OFF = "account recovery disabled";
const TURNED_ON = "account recovery enabled";
const TRUE_FIELD = "050000000101";

const keys = testKeyProvider();
const alarms: SecurityStateAlarm[] = [];
let mounted: MountedAuth;
let clock: TestClock;
let accounts = 0;

beforeAll(async () => {
	clock = createTestClock();
	mounted = await mountAuth("norecovery_seal", {
		clock,
		keys,
		securityState: { sealing: "required", alarm: (alarm) => alarms.push(alarm) },
		webauthn: {
			relyingPartyId: RELYING_PARTY_ID,
			relyingPartyName: "Velve Auth tests",
			origins: [TEST_ORIGIN],
			userVerification: "required",
		},
		rateLimit: {
			perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
			perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
		},
	});
}, 120_000);

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

beforeEach(() => {
	alarms.length = 0;
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

async function errorCodeOf(answer: Response): Promise<string> {
	return ((await answer.json()) as { error: { code: string } }).error.code;
}

function withSession(token: string): Record<string, string> {
	return { Cookie: `${DEFAULT_COOKIE_NAMES.session}=${token}` };
}

interface Account {
	readonly email: string;
	readonly userId: string;
	readonly sessionToken: string;
}

async function signUp(): Promise<Account> {
	accounts += 1;
	const email = `no-recovery-seal-${accounts}@example.com`;
	const answer = await mounted.handler(postTo("/sign-up", { email, password: PASSWORD }));
	const sessionToken = cookieIn(answer, DEFAULT_COOKIE_NAMES.session);
	const body = (await answer.json()) as { user: { id: string } };
	if (answer.status !== 200 || sessionToken === null) {
		throw new Error(`the sign-up answered ${answer.status} without a session`);
	}
	return { email, userId: body.user.id, sessionToken };
}

async function signInWithPassword(email: string): Promise<string> {
	const answer = await mounted.handler(postTo("/sign-in/password", { email, password: PASSWORD }));
	const token = cookieIn(answer, DEFAULT_COOKIE_NAMES.session);
	if (answer.status !== 200 || token === null) {
		throw new Error(`the sign-in answered ${answer.status} without a session`);
	}
	return token;
}

async function enrolTotp(account: Account): Promise<void> {
	const started = await mounted.handler(
		postTo("/factor/totp/enroll/start", {}, withSession(account.sessionToken)),
	);
	const { secretBase32 } = (await started.json()) as { secretBase32: string };
	const code = totpCodeForStep(secretBytesOfBase32(secretBase32), timeStepAt(clock.now()));
	const finished = await mounted.handler(
		postTo("/factor/totp/enroll/finish", { code }, withSession(account.sessionToken)),
	);
	expect([started.status, finished.status]).toStrictEqual([200, 204]);
	clock.advanceBy(2 * ONE_TOTP_STEP_IN_MILLISECONDS);
}

async function registerPasskey(account: Account): Promise<void> {
	const authenticator = await createVirtualAuthenticator({
		relyingPartyId: RELYING_PARTY_ID,
		origin: TEST_ORIGIN,
		flags: { userVerified: true, backupEligible: true, backupState: true },
	});
	const started = await mounted.handler(
		postTo("/factor/webauthn/register/start", {}, withSession(account.sessionToken)),
	);
	const challenge = (await started.json()) as { challengeToken: string };
	const finished = await mounted.handler(
		postTo(
			"/factor/webauthn/register/finish",
			{
				challengeToken: challenge.challengeToken,
				response: await authenticator.attest({ challenge: challenge.challengeToken }),
				label: "A key",
			},
			withSession(account.sessionToken),
		),
	);
	expect([started.status, finished.status]).toStrictEqual([200, 200]);
}

async function generateRecoveryCodes(account: Account): Promise<readonly string[]> {
	const answer = await mounted.handler(
		postTo("/factor/recovery/generate", {}, withSession(account.sessionToken)),
	);
	expect(answer.status).toBe(200);
	return ((await answer.json()) as { codes: readonly string[] }).codes;
}

async function mailedToken(path: string, email: string, kind: string): Promise<string> {
	mounted.email.clear();
	const requested = await mounted.handler(postTo(path, { email }));
	expect(requested.status).toBe(204);
	const message = mounted.email.messages.find((sent) => sent.kind === kind);
	if (message === undefined || !("token" in message)) {
		throw new Error(`no ${kind} message was sent`);
	}
	return message.token;
}

async function recoveryCodeRows(userId: string): Promise<number> {
	const [row] = await mounted.connection.query<{ total: number }>(
		`SELECT count(*)::integer AS total FROM ${mounted.schema}.recovery_code WHERE user_id = $1`,
		[userId],
	);
	return row?.total ?? -1;
}

async function resolvedUserOf(sessionToken: string): Promise<{ id: string } | null> {
	const answer = await mounted.handler(
		requestTo("/session", {
			method: "GET",
			cookie: `${DEFAULT_COOKIE_NAMES.session}=${sessionToken}`,
		}),
	);
	if (answer.status !== 200) {
		return null;
	}
	const body = (await answer.json()) as { user: { id: string } } | null;
	return body?.user ?? null;
}

function linesSaying(message: string) {
	return mounted.log.lines.filter((line) => line.message === message);
}

async function sealVerdictOf(userId: string): Promise<string> {
	const read = await readSecurityState(mounted.connection, mounted.schema, userId);
	if (read === null) {
		throw new Error("the account is gone");
	}
	return (await checkSecurityState(keys, read, "required")).verdict;
}

describe("turning recovery off and on (S-INTEG-11)", () => {
	it("deletes the codes, keeps both sessions, retires the mailed links and logs the account id only", async () => {
		const account = await signUp();
		const second = await signInWithPassword(account.email);
		await enrolTotp(account);
		await registerPasskey(account);
		await generateRecoveryCodes(account);
		const resetToken = await mailedToken(
			"/password/request-reset",
			account.email,
			"password_reset",
		);
		const magicToken = await mailedToken(
			"/sign-in/magic-link/request",
			account.email,
			"magic_link",
		);
		expect(await recoveryCodeRows(account.userId)).toBe(10);
		const before = linesSaying(TURNED_OFF).length;

		await mounted.auth.user.disableRecovery({ userId: account.userId });

		expect(await recoveryCodeRows(account.userId)).toBe(0);
		expect(await resolvedUserOf(account.sessionToken)).toMatchObject({ id: account.userId });
		expect(await resolvedUserOf(second)).toMatchObject({ id: account.userId });
		expect(
			(await mounted.auth.user.findById({ userId: account.userId }))?.recoveryDisabledAt,
		).toBeInstanceOf(Date);
		expect(await sealVerdictOf(account.userId)).toBe("valid");
		const turnedOff = linesSaying(TURNED_OFF).slice(before);
		expect(turnedOff).toStrictEqual([
			{ level: "warn", message: TURNED_OFF, fields: { userId: account.userId } },
		]);

		await mounted.auth.user.enableRecovery({ userId: account.userId });

		expect(linesSaying(TURNED_ON).at(-1)).toStrictEqual({
			level: "warn",
			message: TURNED_ON,
			fields: { userId: account.userId },
		});
		expect(
			(await mounted.auth.user.findById({ userId: account.userId }))?.recoveryDisabledAt,
		).toBeNull();
		const reset = await mounted.handler(
			postTo("/password/redeem-reset", { token: resetToken, newPassword: REPLACEMENT }),
		);
		const magic = await mounted.handler(
			postTo("/sign-in/magic-link/redeem", { token: magicToken }),
		);
		expect([reset.status, magic.status]).toStrictEqual([400, 400]);
		expect([await errorCodeOf(reset), await errorCodeOf(magic)]).toStrictEqual([
			"invalid_token",
			"invalid_token",
		]);
		expect(await resolvedUserOf(account.sessionToken)).toMatchObject({ id: account.userId });
		expect(alarms).toStrictEqual([]);
	});

	it("names no address in any line the two calls log", async () => {
		const account = await signUp();
		const first = mounted.log.lines.length;

		await mounted.auth.user.disableRecovery({ userId: account.userId });
		await mounted.auth.user.enableRecovery({ userId: account.userId });

		const logged = JSON.stringify(mounted.log.lines.slice(first));
		expect(logged).toContain(account.userId);
		expect(logged).not.toContain(account.email);
		expect(logged).not.toContain("@");
	});

	it("restores the mailed paths once recovery is on again", async () => {
		const account = await signUp();
		await mounted.auth.user.disableRecovery({ userId: account.userId });
		await mounted.auth.user.enableRecovery({ userId: account.userId });

		const token = await mailedToken("/password/request-reset", account.email, "password_reset");
		const reset = await mounted.handler(
			postTo("/password/redeem-reset", { token, newPassword: REPLACEMENT }),
		);

		expect(reset.status).toBe(200);
		expect(((await reset.json()) as { status: string }).status).toBe("password_reset");
	});

	it("refuses an account that does not exist and logs nothing", async () => {
		const first = mounted.log.lines.length;
		const unknown = "00000000-0000-4000-8000-00000000a11c";

		await expect(mounted.auth.user.disableRecovery({ userId: unknown })).rejects.toMatchObject({
			code: "invalid_input",
		});
		await expect(mounted.auth.user.enableRecovery({ userId: "not-an-id" })).rejects.toBeInstanceOf(
			VelveError,
		);
		expect(
			mounted.log.lines.slice(first).filter((line) => line.message.startsWith("account recovery")),
		).toStrictEqual([]);
	});

	it("is a server method with no route and no client call", () => {
		const names = mounted.auth.routes.map((route) => route.name);
		const paths = mounted.auth.routes.map((route) => route.path);

		expect(
			names.filter((name) => /^user\.|RecoveryDisabled|ableRecovery/.test(name)),
		).toStrictEqual([]);
		expect(paths.filter((path) => path.startsWith("/user"))).toStrictEqual([]);
		expect(typeof mounted.auth.user.disableRecovery).toBe("function");
		expect(typeof mounted.auth.user.enableRecovery).toBe("function");
	});
});

describe("a writer of the database without the root key (S-INTEG-11)", () => {
	it("cannot turn the switch off by clearing the column", async () => {
		const account = await signUp();
		await mounted.auth.user.disableRecovery({ userId: account.userId });
		await mounted.connection.query(
			`UPDATE ${mounted.schema}.user SET recovery_disabled_at = NULL WHERE id = $1`,
			[account.userId],
		);

		const signIn = await mounted.handler(
			postTo("/sign-in/password", { email: account.email, password: PASSWORD }),
		);
		const resolved = await resolvedUserOf(account.sessionToken);
		const token = await mailedToken("/password/request-reset", account.email, "password_reset");
		const reset = await mounted.handler(
			postTo("/password/redeem-reset", { token, newPassword: REPLACEMENT }),
		);
		const generated = await mounted.handler(
			postTo("/factor/recovery/generate", {}, withSession(account.sessionToken)),
		);

		expect([signIn.status, reset.status, generated.status]).toStrictEqual([401, 400, 401]);
		expect(await errorCodeOf(reset)).toBe("invalid_token");
		expect(resolved).toBeNull();
		expect(await sealVerdictOf(account.userId)).toBe("seal_mismatch");
		expect(await recoveryCodeRows(account.userId)).toBe(0);
		const raised = alarms.filter((alarm) => alarm.reason !== "suppressed");
		expect(new Set(raised.map((alarm) => alarm.reason))).toStrictEqual(new Set(["seal_mismatch"]));
		expect(new Set(raised.map((alarm) => alarm.occasion))).toStrictEqual(
			new Set(["sign_in", "session_resolve", "token_redemption"]),
		);
	});

	it("breaks the state of an account whose switch it sets", async () => {
		const account = await signUp();
		await mounted.connection.query(
			`UPDATE ${mounted.schema}.user SET recovery_disabled_at = now() WHERE id = $1`,
			[account.userId],
		);

		const signIn = await mounted.handler(
			postTo("/sign-in/password", { email: account.email, password: PASSWORD }),
		);
		const resolved = await resolvedUserOf(account.sessionToken);

		expect(signIn.status).toBe(401);
		expect(await errorCodeOf(signIn)).toBe("invalid_credentials");
		expect(resolved).toBeNull();
		expect(await sealVerdictOf(account.userId)).toBe("seal_mismatch");
		expect(alarms.map((alarm) => [alarm.occasion, alarm.reason])).toStrictEqual([
			["sign_in", "seal_mismatch"],
			["session_resolve", "seal_mismatch"],
		]);
	});

	it("is not obeyed by a switch call over a broken state", async () => {
		const account = await signUp();
		await mounted.connection.query(
			`UPDATE ${mounted.schema}.user SET recovery_disabled_at = now() WHERE id = $1`,
			[account.userId],
		);

		await expect(mounted.auth.user.enableRecovery({ userId: account.userId })).rejects.toThrow();

		expect(await sealVerdictOf(account.userId)).toBe("seal_mismatch");
		expect(alarms.map((alarm) => [alarm.occasion, alarm.reason])).toStrictEqual([
			["change", "seal_mismatch"],
		]);
	});
});

describe("an account that never turns the switch on (S-INTEG-11)", () => {
	it("keeps the encoding it had before migration 6, and its stored seal is taken over it", async () => {
		const account = await signUp();
		const read = await readSecurityState(mounted.connection, mounted.schema, account.userId);
		if (read === null || read.seal === null) {
			throw new Error("the account has no seal");
		}
		const state = securityStateOf(read, read.seal);
		const unused = Buffer.from(encodeSecurityState(state)).toString("hex");
		const switched = Buffer.from(
			encodeSecurityState({ ...state, recoveryDisabled: true }),
		).toString("hex");

		expect(read.recoveryDisabled).toBe(false);
		expect(switched).toBe(`${unused}${TRUE_FIELD}`);
		expect(unused.endsWith(TRUE_FIELD)).toBe(false);
		expect(Buffer.from((await computeSeal(keys, state)).digest).toString("hex")).toBe(
			Buffer.from(read.seal.digest).toString("hex"),
		);
	});
});

describe("the switch against changes running beside it (S-INTEG-11, S-INTEG-3)", () => {
	const ROUNDS = 10;
	let pool: Awaited<ReturnType<typeof openConnectionPool>>;
	let pooled: VelveAuth<"email">;
	let handler: (request: Request) => Promise<Response>;

	beforeAll(async () => {
		pool = await openConnectionPool(6);
		pooled = createVelveAuth(
			configFor({
				database: pool,
				schema: mounted.schema,
				keys,
				clock,
				securityState: { sealing: "required", alarm: (alarm) => alarms.push(alarm) },
				rateLimit: {
					perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
					perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
				},
			}),
		);
		handler = toWebHandler(pooled);
	});

	afterAll(async () => {
		await pool.close();
	});

	it("leaves a valid seal and no recovery code behind whatever the order", async () => {
		const account = await signUp();
		for (let round = 0; round < ROUNDS; round += 1) {
			await pooled.user.enableRecovery({ userId: account.userId });
			const [generated] = await Promise.all([
				handler(postTo("/factor/recovery/generate", {}, withSession(account.sessionToken))),
				pooled.user.disableRecovery({ userId: account.userId }),
			]);

			expect([200, 409]).toContain(generated.status);
			expect(await sealVerdictOf(account.userId)).toBe("valid");
			expect(await recoveryCodeRows(account.userId)).toBe(0);
		}
		expect(alarms).toStrictEqual([]);
	});
});
