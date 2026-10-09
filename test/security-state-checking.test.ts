import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import type { SecurityStateAlarm } from "../src/core/security-state/alarm.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { type MountedAuth, mountAuth, requestTo, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { normalisedAnswer, postTo } from "./flows-fixtures.js";
import {
	codeCarrying,
	createStubProvider,
	oauthConfigFor,
	type StubProvider,
} from "./oauth-provider.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";
import { createVirtualAuthenticator, type VirtualAuthenticator } from "./webauthn-simulator.js";

//every path checks the seal before it uses the account and answers a broken state as its ordinary failure (S-INTEG-4, S-INTEG-5)

const PASSWORD = "a password long enough for the policy 3d9a";
const RELYING_PARTY_ID = "app.example.com";
const ONE_TOTP_STEP_IN_MILLISECONDS = 30_000;

let mounted: MountedAuth;
let clock: TestClock;
let provider: StubProvider;
const alarms: SecurityStateAlarm[] = [];

beforeAll(async () => {
	clock = createTestClock();
	provider = await createStubProvider({
		claims: { sub: "unused", email: "unused@example.com", email_verified: true },
	});
	mounted = await mountAuth("integchecking", {
		clock,
		securityState: { sealing: "required", alarm: (alarm) => alarms.push(alarm) },
		webauthn: {
			relyingPartyId: RELYING_PARTY_ID,
			relyingPartyName: "Velve Auth tests",
			origins: [TEST_ORIGIN],
			userVerification: "required",
		},
		oauth: oauthConfigFor({ openIdConnect: false }),
		fetch: provider.fetch,
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

let accounts = 0;
const presentedSecrets: string[] = [PASSWORD];

interface Account {
	readonly email: string;
	readonly userId: string;
	readonly session: string;
}

async function signUp(): Promise<Account> {
	accounts += 1;
	const email = `checking${accounts}@example.com`;
	const answer = await mounted.handler(postTo("/sign-up", { email, password: PASSWORD }));
	expect(answer.status).toBe(200);
	const userId = ((await answer.json()) as { user: { id: string } }).user.id;
	const session = cookieIn(answer, DEFAULT_COOKIE_NAMES.session) ?? "";
	presentedSecrets.push(session);
	return { email, userId, session };
}

//a writer who cannot compute the seal leaves a digest that matches no state
async function breakTheStateOf(userId: string): Promise<void> {
	await mounted.connection.query(
		`UPDATE ${mounted.schema}.security_state SET digest = $2 WHERE user_id = $1`,
		[userId, randomBytes(32)],
	);
}

async function alarmsRaisedFor(userId: string): Promise<readonly string[]> {
	await new Promise((resolve) => setTimeout(resolve, 50));
	return alarms
		.filter((alarm) => alarm.userId === userId)
		.map((alarm) => `${alarm.occasion} ${alarm.reason}`);
}

function totpCodeNow(secretBase32: string, offset = 0): string {
	return totpCodeForStep(secretBytesOfBase32(secretBase32), timeStepAt(clock.now()) + offset);
}

async function enrolTotp(session: string): Promise<string> {
	const started = await mounted.handler(
		postTo("/factor/totp/enroll/start", {}, withSession(session)),
	);
	const { secretBase32 } = (await started.json()) as { secretBase32: string };
	const finished = await mounted.handler(
		postTo("/factor/totp/enroll/finish", { code: totpCodeNow(secretBase32) }, withSession(session)),
	);
	expect([started.status, finished.status]).toStrictEqual([200, 204]);
	clock.advanceBy(2 * ONE_TOTP_STEP_IN_MILLISECONDS);
	return secretBase32;
}

function newAuthenticator(): Promise<VirtualAuthenticator> {
	return createVirtualAuthenticator({
		relyingPartyId: RELYING_PARTY_ID,
		origin: TEST_ORIGIN,
		flags: { userVerified: true, backupEligible: true, backupState: true },
	});
}

async function registerAuthenticator(session: string): Promise<VirtualAuthenticator> {
	const authenticator = await newAuthenticator();
	const started = await mounted.handler(
		postTo("/factor/webauthn/register/start", {}, withSession(session)),
	);
	const { challengeToken } = (await started.json()) as { challengeToken: string };
	const finished = await mounted.handler(
		postTo(
			"/factor/webauthn/register/finish",
			{
				challengeToken,
				response: await authenticator.attest({ challenge: challengeToken }),
				label: "A key",
			},
			withSession(session),
		),
	);
	expect([started.status, finished.status]).toStrictEqual([200, 200]);
	return authenticator;
}

async function signInWithPasskey(authenticator: VirtualAuthenticator): Promise<Response> {
	const started = await mounted.handler(postTo("/sign-in/passkey/start", {}));
	const { challengeToken } = (await started.json()) as { challengeToken: string };
	return mounted.handler(
		postTo("/sign-in/passkey/finish", {
			challengeToken,
			response: await authenticator.assert({ challenge: challengeToken }),
		}),
	);
}

async function pendingOf(email: string): Promise<string> {
	const answer = await mounted.handler(postTo("/sign-in/password", { email, password: PASSWORD }));
	const pending = cookieIn(answer, DEFAULT_COOKIE_NAMES.pending);
	if (pending === null) {
		throw new Error(`no pending authentication, status ${answer.status}`);
	}
	return pending;
}

async function passkeyAsSecondFactor(
	pending: string,
	authenticator: VirtualAuthenticator,
): Promise<Response> {
	const started = await mounted.handler(
		postTo("/factor/webauthn/authenticate/start", {}, withPending(pending)),
	);
	const { challengeToken } = (await started.json()) as { challengeToken: string };
	return mounted.handler(
		postTo(
			"/factor/webauthn/authenticate/finish",
			{ challengeToken, response: await authenticator.assert({ challenge: challengeToken }) },
			withPending(pending),
		),
	);
}

function mailedToken(kind: string, to: string): string {
	const message = mounted.email.messages
		.filter((sent) => sent.kind === kind && sent.to === to)
		.at(-1);
	if (message === undefined || !("token" in message)) {
		throw new Error(`no ${kind} message to ${to}`);
	}
	return message.token;
}

interface OpenedFlow {
	readonly state: string;
	readonly pointer: string;
}

async function startOAuth(): Promise<OpenedFlow> {
	const answer = await mounted.handler(
		requestTo("/sign-in/oauth/start", { body: { provider: "stubby" } }),
	);
	const body = (await answer.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string };
	};
	return {
		state: new URL(body.authorizationUrl).searchParams.get("state") ?? "",
		pointer: body.stateCookie.value,
	};
}

function completeOAuth(flow: OpenedFlow): Promise<Response> {
	return mounted.handler(
		requestTo(
			`/sign-in/oauth/callback/stubby?code=${codeCarrying(null)}&state=${encodeURIComponent(flow.state)}`,
			{ method: "GET", cookie: `${DEFAULT_COOKIE_NAMES.oauthState}=${flow.pointer}` },
		),
	);
}

const UNKNOWN_TOKEN = "an-unknown-token-0123456789abcdefghijklmnopqrstuv";

interface Refusal {
	readonly path: string;
	readonly broken: string;
	readonly ordinary: string;
	readonly alarms: readonly string[];
}

const refusals: Refusal[] = [];

async function refusedAs(
	path: string,
	userId: string,
	broken: Response,
	ordinary: Response,
): Promise<Refusal> {
	const refusal = {
		path,
		broken: await normalisedAnswer(broken),
		ordinary: await normalisedAnswer(ordinary),
		alarms: await alarmsRaisedFor(userId),
	};
	refusals.push(refusal);
	return refusal;
}

describe("T-INTEG-4: every path refuses a broken state with one alarm of its occasion (S-INTEG-4)", () => {
	it("refuses the password sign-in like a wrong password", async () => {
		const victim = await signUp();
		const intact = await signUp();
		await breakTheStateOf(victim.userId);

		const refusal = await refusedAs(
			"password sign-in",
			victim.userId,
			await mounted.handler(
				postTo("/sign-in/password", { email: victim.email, password: PASSWORD }),
			),
			await mounted.handler(
				postTo("/sign-in/password", { email: intact.email, password: `${PASSWORD}x` }),
			),
		);

		expect(refusal.broken).toBe(refusal.ordinary);
		expect(refusal.alarms).toStrictEqual(["sign_in seal_mismatch"]);
	});

	it("refuses the passkey sign-in like an unknown passkey", async () => {
		const victim = await signUp();
		const authenticator = await registerAuthenticator(victim.session);
		await breakTheStateOf(victim.userId);

		const refusal = await refusedAs(
			"passkey sign-in",
			victim.userId,
			await signInWithPasskey(authenticator),
			await signInWithPasskey(await newAuthenticator()),
		);

		expect(refusal.broken).toBe(refusal.ordinary);
		expect(refusal.alarms).toStrictEqual(["sign_in seal_mismatch"]);
	});

	it("refuses the OAuth sign-in like a callback with an unknown state", async () => {
		accounts += 1;
		const subject = `checking-oauth-${accounts}`;
		provider.reportClaims({ sub: subject, email: `${subject}@provider.example` });
		const first = await completeOAuth(await startOAuth());
		expect(first.status).toBe(302);
		const [identity] = await mounted.connection.query<{ user_id: string }>(
			`SELECT user_id FROM ${mounted.schema}.identity WHERE subject = $1`,
			[subject],
		);
		const userId = identity?.user_id ?? "";
		await breakTheStateOf(userId);
		const unknown = await startOAuth();

		const refusal = await refusedAs(
			"OAuth sign-in",
			userId,
			await completeOAuth(await startOAuth()),
			await completeOAuth({ state: "no-such-state", pointer: unknown.pointer }),
		);

		expect(refusal.broken).toBe(refusal.ordinary);
		expect(refusal.alarms).toStrictEqual(["sign_in seal_mismatch"]);
	});

	it("refuses the magic-link redemption like an unknown token", async () => {
		const victim = await signUp();
		await mounted.handler(postTo("/sign-in/magic-link/request", { email: victim.email }));
		const token = mailedToken("magic_link", victim.email);
		await breakTheStateOf(victim.userId);

		const refusal = await refusedAs(
			"magic-link redemption",
			victim.userId,
			await mounted.handler(postTo("/sign-in/magic-link/redeem", { token })),
			await mounted.handler(postTo("/sign-in/magic-link/redeem", { token: UNKNOWN_TOKEN })),
		);

		expect(refusal.broken).toBe(refusal.ordinary);
		expect(refusal.alarms).toStrictEqual(["token_redemption seal_mismatch"]);
	});

	it("refuses the TOTP check like a wrong code", async () => {
		const victim = await signUp();
		const intact = await signUp();
		const secret = await enrolTotp(victim.session);
		const intactSecret = await enrolTotp(intact.session);
		const pending = await pendingOf(victim.email);
		const intactPending = await pendingOf(intact.email);
		await breakTheStateOf(victim.userId);
		const wrong = totpCodeNow(intactSecret) === "000000" ? "000001" : "000000";

		const refusal = await refusedAs(
			"TOTP check",
			victim.userId,
			await mounted.handler(
				postTo("/factor/totp/verify", { code: totpCodeNow(secret) }, withPending(pending)),
			),
			await mounted.handler(
				postTo("/factor/totp/verify", { code: wrong }, withPending(intactPending)),
			),
		);

		expect(refusal.broken).toBe(refusal.ordinary);
		expect(refusal.alarms).toStrictEqual(["factor_check seal_mismatch"]);
	});

	it("refuses the passkey as a second factor like a rejected assertion", async () => {
		const victim = await signUp();
		const intact = await signUp();
		const authenticator = await registerAuthenticator(victim.session);
		await registerAuthenticator(intact.session);
		const pending = await pendingOf(victim.email);
		const intactPending = await pendingOf(intact.email);
		await breakTheStateOf(victim.userId);

		const refusal = await refusedAs(
			"passkey as second factor",
			victim.userId,
			await passkeyAsSecondFactor(pending, authenticator),
			await passkeyAsSecondFactor(intactPending, await newAuthenticator()),
		);

		expect(refusal.broken).toBe(refusal.ordinary);
		expect(refusal.alarms).toStrictEqual(["factor_check seal_mismatch"]);
	});

	it("refuses the recovery code as a second factor like an unknown code", async () => {
		const victim = await signUp();
		const intact = await signUp();
		const codesOf = async (account: Account): Promise<readonly string[]> => {
			await enrolTotp(account.session);
			const generated = await mounted.handler(
				postTo("/factor/recovery/generate", {}, withSession(account.session)),
			);
			return ((await generated.json()) as { codes: string[] }).codes;
		};
		const [code] = await codesOf(victim);
		await codesOf(intact);
		const pending = await pendingOf(victim.email);
		const intactPending = await pendingOf(intact.email);
		await breakTheStateOf(victim.userId);

		const refusal = await refusedAs(
			"recovery code as second factor",
			victim.userId,
			await mounted.handler(postTo("/factor/recovery/verify", { code }, withPending(pending))),
			await mounted.handler(
				postTo(
					"/factor/recovery/verify",
					{ code: "AAAAA-AAAAA-AAAAA-AAAAA" },
					withPending(intactPending),
				),
			),
		);

		expect(refusal.broken).toBe(refusal.ordinary);
		expect(refusal.alarms).toStrictEqual(["factor_check seal_mismatch"]);
	});

	it("refuses the session resolution like an unknown session", async () => {
		const victim = await signUp();
		await breakTheStateOf(victim.userId);
		const resolving = (token: string) =>
			mounted.handler(
				new Request("https://api.example.com/session", {
					method: "GET",
					headers: { Origin: TEST_ORIGIN, ...withSession(token) },
				}),
			);

		const refusal = await refusedAs(
			"session resolution",
			victim.userId,
			await resolving(victim.session),
			await resolving(UNKNOWN_TOKEN),
		);

		expect(refusal.broken).toBe(refusal.ordinary);
		expect(refusal.alarms).toStrictEqual(["session_resolve seal_mismatch"]);
	});

	it("refuses the reset redemption like an unknown token", async () => {
		const victim = await signUp();
		await mounted.handler(postTo("/password/request-reset", { email: victim.email }));
		const token = mailedToken("password_reset", victim.email);
		await breakTheStateOf(victim.userId);
		const redeeming = (presented: string) =>
			mounted.handler(
				postTo("/password/redeem-reset", { token: presented, newPassword: `${PASSWORD} new` }),
			);

		const refusal = await refusedAs(
			"reset redemption",
			victim.userId,
			await redeeming(token),
			await redeeming(UNKNOWN_TOKEN),
		);

		expect(refusal.broken).toBe(refusal.ordinary);
		expect(refusal.alarms).toStrictEqual(["token_redemption seal_mismatch"]);
	});

	it("refuses the redemption of the address confirmation like an unknown token", async () => {
		const victim = await signUp();
		const token = mailedToken("email_verification", victim.email);
		await breakTheStateOf(victim.userId);

		const refusal = await refusedAs(
			"address confirmation",
			victim.userId,
			await mounted.handler(postTo("/email/redeem-verification", { token })),
			await mounted.handler(postTo("/email/redeem-verification", { token: UNKNOWN_TOKEN })),
		);

		expect(refusal.broken).toBe(refusal.ordinary);
		expect(refusal.alarms).toStrictEqual(["token_redemption seal_mismatch"]);
	});

	it("refuses the redemption of an address change like an unknown token", async () => {
		const victim = await signUp();
		const moved = `moved-${victim.email}`;
		const requested = await mounted.handler(
			postTo("/email/request-change", { newEmail: moved }, withSession(victim.session)),
		);
		expect(requested.status).toBeLessThan(300);
		const token = mailedToken("email_change", moved);
		await breakTheStateOf(victim.userId);

		const refusal = await refusedAs(
			"address change",
			victim.userId,
			await mounted.handler(postTo("/email/redeem-change", { token })),
			await mounted.handler(postTo("/email/redeem-change", { token: UNKNOWN_TOKEN })),
		);

		expect(refusal.broken).toBe(refusal.ordinary);
		expect(refusal.alarms).toStrictEqual(["token_redemption seal_mismatch"]);
	});

	it("counts eleven of eleven paths refused with one alarm each", () => {
		expect(refusals.map((refusal) => refusal.path)).toHaveLength(11);
		expect(refusals.filter((refusal) => refusal.alarms.length === 1)).toHaveLength(11);
	});
});

describe("T-INTEG-4: a missing seal row (S-INTEG-4)", () => {
	it("is refused under required with one alarm seal_missing", async () => {
		const victim = await signUp();
		await mounted.connection.query(
			`DELETE FROM ${mounted.schema}.security_state WHERE user_id = $1`,
			[victim.userId],
		);

		const answer = await mounted.handler(
			postTo("/sign-in/password", { email: victim.email, password: PASSWORD }),
		);

		expect(answer.status).toBe(401);
		expect(await alarmsRaisedFor(victim.userId)).toStrictEqual(["sign_in seal_missing"]);
	});

	it("is served under migrating", async () => {
		const migrating = await mountAuth("integcheckingmigrating", {
			securityState: { sealing: "migrating" },
		});
		try {
			const signedUp = await migrating.handler(
				postTo("/sign-up", { email: "unsealed@example.com", password: PASSWORD }),
			);
			const userId = ((await signedUp.json()) as { user: { id: string } }).user.id;
			await migrating.connection.query(
				`DELETE FROM ${migrating.schema}.security_state WHERE user_id = $1`,
				[userId],
			);

			const answer = await migrating.handler(
				postTo("/sign-in/password", { email: "unsealed@example.com", password: PASSWORD }),
			);

			expect(answer.status).toBe(200);
		} finally {
			await dropSchema(migrating.connection, migrating.schema);
			await migrating.connection.close();
		}
	});
});

//alarm and log carry the reason and never a secret (S-INTEG-5)
describe("T-INTEG-5: what the alarms and the log of every refusal above carry", () => {
	async function storedValues(sql: string): Promise<string[]> {
		const rows = await mounted.connection.query<{ value: Uint8Array }>(sql, []);
		return rows.flatMap((row) => {
			const bytes = Buffer.from(row.value);
			return [bytes.toString("hex"), bytes.toString("base64"), bytes.toString("base64url")];
		});
	}

	it("holds no token, hash, ciphertext or password", async () => {
		const schema = mounted.schema;
		const mailed = mounted.email.messages.flatMap((message) =>
			"token" in message ? [message.token] : [],
		);
		const secrets = [
			...presentedSecrets,
			...mailed,
			...(await storedValues(`SELECT token_sha256 AS value FROM ${schema}.session`)),
			...(await storedValues(`SELECT token_sha256 AS value FROM ${schema}.one_time_token`)),
			...(await storedValues(`SELECT phc AS value FROM ${schema}.password_credential`)),
			...(await storedValues(`SELECT secret_enc AS value FROM ${schema}.totp_credential`)),
			...(await storedValues(`SELECT code_hmac AS value FROM ${schema}.recovery_code`)),
			...(await storedValues(`SELECT digest AS value FROM ${schema}.security_state`)),
		].filter((secret) => secret.length >= 16);
		const carried = JSON.stringify({ alarms, log: mounted.log.lines });

		expect(alarms.length).toBeGreaterThanOrEqual(11);
		expect(secrets.length).toBeGreaterThan(50);
		expect(secrets.filter((secret) => carried.includes(secret))).toStrictEqual([]);
	});
});
