import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import type { VelvePlugin } from "../src/core/plugin/config.js";
import { registerPluginErrorCodes, VelveError } from "../src/index.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { type MountedAuth, mountAuth, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { difference, postTo } from "./flows-fixtures.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";
import { createVirtualAuthenticator, type VirtualAuthenticator } from "./webauthn-simulator.js";

/**
 * S-FIX-7 and S-FIX-8: a mailed password reset of an account with a second factor spends its
 * token and writes nothing else; it answers `second_factor_required` as the magic link does, and
 * only the completion of that factor writes the password, revokes every session and issues one,
 * in the transaction that removes the pending row. Without a second factor the reset is the one
 * it was, now with `status: "password_reset"`.
 */

const PASSWORD = "correct-horse-battery-staple";
const REPLACEMENT = "a different password entirely";
const ONE_TOTP_STEP_IN_MILLISECONDS = 30_000;
const RESET_ROUTE = "/password/redeem-reset";
const REFUSED = { httpStatus: 403, message: "Refused by the reset spy." } as const;

type Point =
	| "beforeSignIn"
	| "afterSignIn"
	| "beforeSessionCreate"
	| "afterSessionCreate"
	| "beforeSessionRevoke";

interface Fired {
	readonly point: Point;
	readonly event: Readonly<Record<string, unknown>>;
}

const fired: Fired[] = [];
let refuseAtBeforeSessionCreate = false;

function at(point: Point) {
	return (event: object): Promise<void> => {
		fired.push({ point, event: { ...event } });
		return point === "beforeSessionCreate" && refuseAtBeforeSessionCreate
			? Promise.reject(new VelveError("resetspy.refused"))
			: Promise.resolve();
	};
}

const SPY: VelvePlugin<"resetspy"> = {
	id: "resetspy",
	hooks: {
		beforeSignIn: at("beforeSignIn"),
		afterSignIn: at("afterSignIn"),
		beforeSessionCreate: at("beforeSessionCreate"),
		afterSessionCreate: at("afterSessionCreate"),
		beforeSessionRevoke: at("beforeSessionRevoke"),
	},
};

const RELYING_PARTY_ID = "app.example.com";

let mounted: MountedAuth;
let clock: TestClock;

beforeAll(async () => {
	registerPluginErrorCodes({ "resetspy.refused": REFUSED });
	clock = createTestClock();
	mounted = await mountAuth("resetfactor", {
		clock,
		plugins: [SPY],
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
	fired.length = 0;
	refuseAtBeforeSessionCreate = false;
});

function cookieIn(answer: Response, name: string): string | null {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === name) {
			return pair.slice(separator + 1);
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

function stepPastTheEnrolmentsWindow(): void {
	clock.advanceBy(2 * ONE_TOTP_STEP_IN_MILLISECONDS);
}

function codeNow(secretBase32: string): string {
	return totpCodeForStep(secretBytesOfBase32(secretBase32), timeStepAt(clock.now()));
}

interface Account {
	readonly email: string;
	readonly userId: string;
	readonly sessionToken: string;
}

let accounts = 0;

async function signUp(): Promise<Account> {
	accounts += 1;
	const email = `reset-factor-${accounts}@example.com`;
	const answer = await mounted.handler(postTo("/sign-up", { email, password: PASSWORD }));
	const sessionToken = cookieIn(answer, DEFAULT_COOKIE_NAMES.session);
	const body = (await answer.json()) as { user: { id: string } };
	if (answer.status !== 200 || sessionToken === null || sessionToken === "") {
		throw new Error(`the sign-up answered ${answer.status} without a session`);
	}
	return { email, userId: body.user.id, sessionToken };
}

async function enrolTotp(account: Account): Promise<string> {
	const started = await mounted.handler(
		postTo("/factor/totp/enroll/start", {}, withSession(account.sessionToken)),
	);
	const { secretBase32 } = (await started.json()) as { secretBase32: string };
	const finished = await mounted.handler(
		postTo(
			"/factor/totp/enroll/finish",
			{ code: codeNow(secretBase32) },
			withSession(account.sessionToken),
		),
	);
	expect([started.status, finished.status]).toStrictEqual([200, 204]);
	return secretBase32;
}

async function generateRecoveryCodes(account: Account): Promise<readonly string[]> {
	const answer = await mounted.handler(
		postTo("/factor/recovery/generate", {}, withSession(account.sessionToken)),
	);
	expect(answer.status).toBe(200);
	return ((await answer.json()) as { codes: readonly string[] }).codes;
}

async function registerPasskey(account: Account): Promise<VirtualAuthenticator> {
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
	return authenticator;
}

async function resetTokenFor(email: string): Promise<string> {
	mounted.email.clear();
	const requested = await mounted.handler(postTo("/password/request-reset", { email }));
	expect(requested.status).toBe(204);
	const message = mounted.email.messages.find((sent) => sent.kind === "password_reset");
	if (message === undefined || message.kind !== "password_reset") {
		throw new Error("no reset message was sent");
	}
	return message.token;
}

interface HeldBack {
	readonly answer: Response;
	readonly body: {
		readonly status: string;
		readonly pendingToken?: string;
		readonly sessionToken?: string;
		readonly pending: {
			readonly factorsCompleted: readonly string[];
			readonly availableFactors: readonly string[];
		};
	};
	readonly pendingToken: string;
}

async function redeemHeldBack(email: string, newPassword = REPLACEMENT): Promise<HeldBack> {
	const token = await resetTokenFor(email);
	const answer = await mounted.handler(postTo(RESET_ROUTE, { token, newPassword }));
	const body = (await answer.clone().json()) as HeldBack["body"];
	const pendingToken = cookieIn(answer, DEFAULT_COOKIE_NAMES.pending);
	expect([answer.status, body.status]).toStrictEqual([200, "second_factor_required"]);
	if (pendingToken === null || pendingToken === "") {
		throw new Error("the held back reset set no pending cookie");
	}
	return { answer, body, pendingToken };
}

async function signInStatus(email: string, password: string): Promise<string> {
	const answer = await mounted.handler(postTo("/sign-in/password", { email, password }));
	if (answer.status !== 200) {
		return `${answer.status} ${((await answer.json()) as { error: { code: string } }).error.code}`;
	}
	return `${answer.status} ${((await answer.json()) as { status: string }).status}`;
}

async function sessionResolves(sessionToken: string): Promise<boolean> {
	const answer = await mounted.handler(
		new Request("https://api.example.com/session", {
			headers: { Origin: TEST_ORIGIN, ...withSession(sessionToken) },
		}),
	);
	expect(answer.status).toBe(200);
	return (await answer.json()) !== null;
}

async function sessionsOf(userId: string): Promise<number> {
	const [row] = await mounted.connection.query<{ total: number }>(
		`SELECT count(*)::integer AS total FROM ${mounted.schema}.session WHERE user_id = $1`,
		[userId],
	);
	return row?.total ?? -1;
}

async function pendingRowsOf(userId: string): Promise<number> {
	const [row] = await mounted.connection.query<{ total: number }>(
		`SELECT count(*)::integer AS total FROM ${mounted.schema}.pending_authentication
		WHERE user_id = $1`,
		[userId],
	);
	return row?.total ?? -1;
}

async function completeWithTotp(pendingToken: string, secret: string): Promise<Response> {
	return mounted.handler(
		postTo("/factor/totp/verify", { code: codeNow(secret) }, withPending(pendingToken)),
	);
}

function pointsFired(): string[] {
	return fired.map((each) => each.point);
}

describe("a mailed reset of an account with TOTP (S-FIX-7)", () => {
	it("spends the token and answers second_factor_required, writing and revoking nothing", async () => {
		const account = await signUp();
		await enrolTotp(account);
		stepPastTheEnrolmentsWindow();
		fired.length = 0;

		const token = await resetTokenFor(account.email);
		const answer = await mounted.handler(postTo(RESET_ROUTE, { token, newPassword: REPLACEMENT }));
		const body = (await answer.json()) as Record<string, unknown> & {
			pending: { factorsCompleted: unknown; availableFactors: unknown };
		};
		const again = await mounted.handler(postTo(RESET_ROUTE, { token, newPassword: REPLACEMENT }));

		expect([answer.status, body.status]).toStrictEqual([200, "second_factor_required"]);
		// Over HTTP the pending token travels in its cookie only, as on every sign-in route.
		expect(Object.keys(body).sort()).toStrictEqual(["pending", "status"]);
		expect(body.pending.factorsCompleted).toStrictEqual([]);
		expect(body.pending.availableFactors).toStrictEqual(["totp"]);
		expect(cookieIn(answer, DEFAULT_COOKIE_NAMES.pending)).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(cookieIn(answer, DEFAULT_COOKIE_NAMES.session)).toBeNull();
		expect(again.status).toBe(400);
		expect(await sessionResolves(account.sessionToken)).toBe(true);
		expect(await signInStatus(account.email, PASSWORD)).toBe("200 second_factor_required");
		expect(await signInStatus(account.email, REPLACEMENT)).toBe("401 invalid_credentials");
		// The plugin points belong to the session, which this request does not issue.
		expect(pointsFired().filter((point) => point.includes("Session"))).toStrictEqual([]);
	});

	it("holds the new password only as an envelope, never as the password or its PHC string", async () => {
		const account = await signUp();
		await enrolTotp(account);
		stepPastTheEnrolmentsWindow();

		await redeemHeldBack(account.email);
		const [row] = await mounted.connection.query<{
			new_password_phc: Uint8Array | null;
			new_password_key_version: number | null;
		}>(
			`SELECT new_password_phc, new_password_key_version
			FROM ${mounted.schema}.pending_authentication WHERE user_id = $1`,
			[account.userId],
		);
		const stored = Buffer.from(row?.new_password_phc ?? new Uint8Array(0));

		expect(stored.length).toBeGreaterThan(32);
		expect(row?.new_password_key_version).toBe(1);
		expect(stored.includes(Buffer.from(REPLACEMENT))).toBe(false);
		expect(stored.includes(Buffer.from("$argon2id$"))).toBe(false);
		expect(JSON.stringify(mounted.log.lines).includes(REPLACEMENT)).toBe(false);
	});

	it("writes the password, revokes every session and issues one when TOTP completes (S-FIX-8)", async () => {
		const account = await signUp();
		const secret = await enrolTotp(account);
		stepPastTheEnrolmentsWindow();
		const held = await redeemHeldBack(account.email);
		fired.length = 0;

		const completed = await completeWithTotp(held.pendingToken, secret);
		const atCompletion = [...fired];
		const body = (await completed.json()) as {
			status: string;
			session: { id: string; factors: string[] };
			user: { id: string };
		};

		expect([completed.status, body.status]).toStrictEqual([200, "signed_in"]);
		expect(body.user.id).toBe(account.userId);
		expect([...body.session.factors].sort()).toStrictEqual(["password", "totp"]);
		expect(cookieIn(completed, DEFAULT_COOKIE_NAMES.pending)).toBe("");
		expect(cookieIn(completed, DEFAULT_COOKIE_NAMES.session)).not.toBeNull();
		expect(await sessionResolves(account.sessionToken)).toBe(false);
		expect(await sessionsOf(account.userId)).toBe(1);
		expect(await pendingRowsOf(account.userId)).toBe(0);
		expect(await signInStatus(account.email, PASSWORD)).toBe("401 invalid_credentials");
		expect(await signInStatus(account.email, REPLACEMENT)).toBe("200 second_factor_required");
		// beforeSignIn never ran for a reset, so neither sign-in point runs at its completion.
		expect(atCompletion.map((each) => each.point)).toStrictEqual([
			"beforeSessionCreate",
			"beforeSessionRevoke",
			"afterSessionCreate",
		]);
		expect(atCompletion[0]?.event).toMatchObject({ userId: account.userId });
		expect([...((atCompletion[0]?.event.factors as string[]) ?? [])].sort()).toStrictEqual([
			"password",
			"totp",
		]);
		expect(atCompletion[1]?.event).toMatchObject({
			userId: account.userId,
			reason: "password_reset",
		});
		expect(atCompletion[2]?.event).toMatchObject({ sessionId: body.session.id });
	});

	it("leaves password and sessions after a wrong code, and after five the row is gone (L-8)", async () => {
		const account = await signUp();
		await enrolTotp(account);
		stepPastTheEnrolmentsWindow();
		const held = await redeemHeldBack(account.email);

		const answers: string[] = [];
		for (let attempt = 0; attempt < 6; attempt += 1) {
			const answer = await mounted.handler(
				postTo("/factor/totp/verify", { code: "000000" }, withPending(held.pendingToken)),
			);
			answers.push(
				`${answer.status} ${((await answer.json()) as { error: { code: string } }).error.code}`,
			);
		}

		expect(answers.slice(0, 4)).toStrictEqual(Array(4).fill("401 invalid_factor_code"));
		expect(answers[4]).toBe("429 too_many_factor_attempts");
		expect(answers[5]).toBe("401 invalid_pending_authentication");
		expect(await pendingRowsOf(account.userId)).toBe(0);
		expect(await sessionResolves(account.sessionToken)).toBe(true);
		expect(await signInStatus(account.email, PASSWORD)).toBe("200 second_factor_required");
		expect(await signInStatus(account.email, REPLACEMENT)).toBe("401 invalid_credentials");
	});

	it("leaves password and sessions when the pending authentication is cancelled", async () => {
		const account = await signUp();
		const secret = await enrolTotp(account);
		stepPastTheEnrolmentsWindow();
		const held = await redeemHeldBack(account.email);

		const cancelled = await mounted.handler(
			postTo("/pending/cancel", {}, withPending(held.pendingToken)),
		);
		const completed = await completeWithTotp(held.pendingToken, secret);

		expect(cancelled.status).toBe(204);
		expect(completed.status).toBe(401);
		expect(await sessionResolves(account.sessionToken)).toBe(true);
		expect(await signInStatus(account.email, PASSWORD)).toBe("200 second_factor_required");
		expect(await signInStatus(account.email, REPLACEMENT)).toBe("401 invalid_credentials");
	});

	it("leaves password and sessions when the pending authentication has expired", async () => {
		const account = await signUp();
		const secret = await enrolTotp(account);
		stepPastTheEnrolmentsWindow();
		const held = await redeemHeldBack(account.email);
		await mounted.connection.query(
			`UPDATE ${mounted.schema}.pending_authentication SET expires_at = now() - interval '1 second'
			WHERE user_id = $1`,
			[account.userId],
		);

		const completed = await completeWithTotp(held.pendingToken, secret);

		expect(completed.status).toBe(401);
		expect(await sessionResolves(account.sessionToken)).toBe(true);
		expect(await signInStatus(account.email, PASSWORD)).toBe("200 second_factor_required");
	});

	it("leaves password and sessions when a plugin refuses the session at completion", async () => {
		const account = await signUp();
		const secret = await enrolTotp(account);
		stepPastTheEnrolmentsWindow();
		const held = await redeemHeldBack(account.email);
		refuseAtBeforeSessionCreate = true;
		fired.length = 0;

		const refused = await completeWithTotp(held.pendingToken, secret);
		const atCompletion = pointsFired();

		expect(refused.status).toBe(403);
		expect(await sessionResolves(account.sessionToken)).toBe(true);
		expect(await pendingRowsOf(account.userId)).toBe(1);
		expect(await signInStatus(account.email, PASSWORD)).toBe("200 second_factor_required");
		expect(atCompletion).toStrictEqual(["beforeSessionCreate"]);
	});
});

describe("a mailed reset completed with another second factor (S-FIX-8)", () => {
	it("completes with a passkey", async () => {
		const account = await signUp();
		const authenticator = await registerPasskey(account);
		const held = await redeemHeldBack(account.email);

		const started = await mounted.handler(
			postTo("/factor/webauthn/authenticate/start", {}, withPending(held.pendingToken)),
		);
		const challenge = (await started.json()) as { challengeToken: string };
		const finished = await mounted.handler(
			postTo(
				"/factor/webauthn/authenticate/finish",
				{
					challengeToken: challenge.challengeToken,
					response: await authenticator.assert({ challenge: challenge.challengeToken }),
				},
				withPending(held.pendingToken),
			),
		);
		const body = (await finished.json()) as {
			status: string;
			session: { factors: string[] };
			signCountRegressed: boolean;
		};

		expect(held.body.pending.availableFactors).toStrictEqual(["webauthn"]);
		expect([started.status, finished.status]).toStrictEqual([200, 200]);
		expect(body.status).toBe("signed_in");
		expect([...body.session.factors].sort()).toStrictEqual(["password", "webauthn"]);
		expect(body.signCountRegressed).toBe(false);
		expect(await sessionResolves(account.sessionToken)).toBe(false);
		expect(await signInStatus(account.email, REPLACEMENT)).toBe("200 second_factor_required");
	});

	it("asks for a recovery code where codes are the only factor, and spends the one it took (E-3633)", async () => {
		const account = await signUp();
		const codes = await generateRecoveryCodes(account);
		const held = await redeemHeldBack(account.email);

		const completed = await mounted.handler(
			postTo("/factor/recovery/verify", { code: codes[0] }, withPending(held.pendingToken)),
		);
		const body = (await completed.json()) as { status: string; session: { factors: string[] } };
		const [remaining] = await mounted.connection.query<{ total: number }>(
			`SELECT count(*)::integer AS total FROM ${mounted.schema}.recovery_code WHERE user_id = $1`,
			[account.userId],
		);

		expect(held.body.pending.availableFactors).toStrictEqual(["recovery"]);
		expect([completed.status, body.status]).toStrictEqual([200, "signed_in"]);
		expect([...body.session.factors].sort()).toStrictEqual(["password", "recovery"]);
		expect(remaining?.total).toBe(codes.length - 1);
		expect(await sessionResolves(account.sessionToken)).toBe(false);
		expect(await signInStatus(account.email, REPLACEMENT)).toBe("200 second_factor_required");
	});

	it("leaves password and sessions after a wrong recovery code", async () => {
		const account = await signUp();
		await generateRecoveryCodes(account);
		const held = await redeemHeldBack(account.email);

		const refused = await mounted.handler(
			postTo(
				"/factor/recovery/verify",
				{ code: "AAAA-AAAA-AAAA-AAAA" },
				withPending(held.pendingToken),
			),
		);

		expect(refused.status).toBe(401);
		expect(await sessionResolves(account.sessionToken)).toBe(true);
		expect(await signInStatus(account.email, PASSWORD)).toBe("200 second_factor_required");
	});
});

describe("a mailed reset of an account without a second factor", () => {
	it("is the reset it was, answered with status password_reset", async () => {
		const account = await signUp();
		const token = await resetTokenFor(account.email);
		fired.length = 0;

		const answer = await mounted.handler(postTo(RESET_ROUTE, { token, newPassword: REPLACEMENT }));
		const atRedemption = pointsFired();
		const body = (await answer.json()) as Record<string, unknown>;

		expect([answer.status, body.status]).toStrictEqual([200, "password_reset"]);
		expect(Object.keys(body).sort()).toStrictEqual([
			"revokedOtherSessionsCount",
			"session",
			"status",
		]);
		expect(body.revokedOtherSessionsCount).toBe(1);
		expect(cookieIn(answer, DEFAULT_COOKIE_NAMES.pending)).toBeNull();
		expect(await sessionResolves(account.sessionToken)).toBe(false);
		expect(await signInStatus(account.email, REPLACEMENT)).toBe("200 signed_in");
		expect(atRedemption).toStrictEqual([
			"beforeSessionCreate",
			"beforeSessionRevoke",
			"afterSessionCreate",
		]);
	});

	it("answers the server method with the same union, narrowed on status", async () => {
		const account = await signUp();
		const token = await resetTokenFor(account.email);

		const result = await mounted.auth.password.redeemReset({
			token,
			newPassword: REPLACEMENT,
			origin: TEST_ORIGIN,
		});

		expect(result.status).toBe("password_reset");
		if (result.status === "password_reset") {
			expect(result.session.userId).toBe(account.userId);
		}
	});
});

describe("a reset token that cannot be redeemed is answered as before", () => {
	it("answers a spent token of an account with a factor as an invented one", async () => {
		const account = await signUp();
		await enrolTotp(account);
		stepPastTheEnrolmentsWindow();
		const token = await resetTokenFor(account.email);
		await mounted.handler(postTo(RESET_ROUTE, { token, newPassword: REPLACEMENT }));

		const spent = await mounted.handler(postTo(RESET_ROUTE, { token, newPassword: REPLACEMENT }));
		const invented = await mounted.handler(
			postTo(RESET_ROUTE, { token: "an-invented-token", newPassword: REPLACEMENT }),
		);

		expect(spent.status).toBe(400);
		expect(await difference(spent, invented)).toStrictEqual([]);
	});

	it("spends the token of a disabled account with a factor and answers as an invented one", async () => {
		const account = await signUp();
		await enrolTotp(account);
		stepPastTheEnrolmentsWindow();
		const token = await resetTokenFor(account.email);
		await mounted.auth.user.disable({ userId: account.userId, reason: "the test disables it" });

		const disabled = await mounted.handler(
			postTo(RESET_ROUTE, { token, newPassword: REPLACEMENT }),
		);
		const invented = await mounted.handler(
			postTo(RESET_ROUTE, { token: "another-invented-token", newPassword: REPLACEMENT }),
		);
		await mounted.auth.user.enable({ userId: account.userId });
		const afterEnable = await mounted.handler(
			postTo(RESET_ROUTE, { token, newPassword: REPLACEMENT }),
		);

		expect(disabled.status).toBe(400);
		expect(await difference(disabled, invented)).toStrictEqual([]);
		expect(afterEnable.status).toBe(400);
		expect(await pendingRowsOf(account.userId)).toBe(0);
	});

	it("refuses an unacceptable new password before the token is spent", async () => {
		const account = await signUp();
		await enrolTotp(account);
		stepPastTheEnrolmentsWindow();
		const token = await resetTokenFor(account.email);

		const refused = await mounted.handler(postTo(RESET_ROUTE, { token, newPassword: "short" }));
		const accepted = await mounted.handler(
			postTo(RESET_ROUTE, { token, newPassword: REPLACEMENT }),
		);

		expect(refused.status).toBe(400);
		expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
			"password_unacceptable",
		);
		expect(((await accepted.json()) as { status: string }).status).toBe("second_factor_required");
	});
});
