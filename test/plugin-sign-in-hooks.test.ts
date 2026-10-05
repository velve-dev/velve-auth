import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import type { PluginHooks, VelvePlugin } from "../src/core/plugin/config.js";
import { registerPluginErrorCodes, VelveError } from "../src/index.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { type MountedAuth, mountAuth, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import {
	codeCarrying,
	createStubProvider,
	oauthConfigFor,
	type StubProvider,
} from "./oauth-provider.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";
import { createVirtualAuthenticator, type VirtualAuthenticator } from "./webauthn-simulator.js";

/**
 * 3.11 enumerates seven hook points and 3.15 G names `password`, `passkey`, `oauth` and
 * `magic_link` as the methods a `SignInEvent` reports. Until this file the four sign-in and
 * session points fired on the OAuth callback alone, so a plugin's veto was bypassed by every
 * other way in. Each path is driven over the mounted handler, and the spy records every point
 * that fired with its event, in order.
 */

type SignInPoint = Exclude<keyof PluginHooks, "beforeSessionRevoke">;

interface Fired {
	readonly point: SignInPoint;
	readonly event: Readonly<Record<string, unknown>>;
}

const PASSWORD = "correct-horse-battery-staple";
const RELYING_PARTY_ID = "app.example.com";
const ONE_TOTP_STEP_IN_MILLISECONDS = 30_000;
const REFUSED = { httpStatus: 403, message: "Refused by the spy." } as const;

let mounted: MountedAuth;
let clock: TestClock;
let provider: StubProvider;
const fired: Fired[] = [];
let refuseAt: SignInPoint | null = null;

function at(point: SignInPoint) {
	return (event: object): Promise<void> => {
		fired.push({ point, event: { ...event } });
		return point === refuseAt ? Promise.reject(new VelveError("spy.refused")) : Promise.resolve();
	};
}

const spy: VelvePlugin = {
	id: "spy",
	hooks: {
		beforeSignIn: at("beforeSignIn"),
		afterSignIn: at("afterSignIn"),
		beforeSessionCreate: at("beforeSessionCreate"),
		afterSessionCreate: at("afterSessionCreate"),
		beforeUserCreate: at("beforeUserCreate"),
		afterUserCreate: at("afterUserCreate"),
	},
};

beforeAll(async () => {
	registerPluginErrorCodes({ "spy.refused": REFUSED });
	clock = createTestClock();
	provider = await createStubProvider({
		claims: { sub: "unused", email: "unused@example.com", email_verified: true },
	});
	mounted = await mountAuth("signinhooks", {
		clock,
		plugins: [spy],
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

beforeEach(() => {
	fired.length = 0;
	refuseAt = null;
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

function cookies(values: { session?: string; pending?: string; oauthState?: string }): {
	Cookie: string;
} {
	const pairs = [
		values.session === undefined ? null : `${DEFAULT_COOKIE_NAMES.session}=${values.session}`,
		values.pending === undefined ? null : `${DEFAULT_COOKIE_NAMES.pending}=${values.pending}`,
		values.oauthState === undefined
			? null
			: `${DEFAULT_COOKIE_NAMES.oauthState}=${values.oauthState}`,
	];
	return { Cookie: pairs.filter((pair) => pair !== null).join("; ") };
}

function points(): readonly SignInPoint[] {
	return fired.map((entry) => entry.point);
}

function eventAt(point: SignInPoint): Readonly<Record<string, unknown>> {
	const found = fired.filter((entry) => entry.point === point);
	expect(found, `${point} fired ${found.length} times`).toHaveLength(1);
	return found[0]?.event ?? {};
}

async function sessionRowsOf(userId: string): Promise<number> {
	const [row] = await mounted.connection.query<{ count: number }>(
		`SELECT count(*)::int AS count FROM ${mounted.schema}.session WHERE user_id = $1`,
		[userId],
	);
	return row?.count ?? -1;
}

async function userIdOf(email: string): Promise<string | null> {
	const [row] = await mounted.connection.query<{ id: string }>(
		`SELECT id FROM ${mounted.schema}.user WHERE email = $1`,
		[email],
	);
	return row?.id ?? null;
}

let accounts = 0;

function freshAddress(): string {
	accounts += 1;
	return `hooks${accounts}@example.com`;
}

interface Account {
	readonly email: string;
	readonly userId: string;
	readonly sessionToken: string;
}

async function signUp(): Promise<Account> {
	const email = freshAddress();
	const answer = await mounted.handler(postTo("/sign-up", { email, password: PASSWORD }));
	expect(answer.status).toBe(200);
	const sessionToken = cookieIn(answer, DEFAULT_COOKIE_NAMES.session) ?? "";
	const userId = (await userIdOf(email)) ?? "";
	fired.length = 0;
	return { email, userId, sessionToken };
}

function totpCodeNow(secretBase32: string): string {
	return totpCodeForStep(secretBytesOfBase32(secretBase32), timeStepAt(clock.now()));
}

async function enrolTotp(sessionToken: string): Promise<string> {
	const started = await mounted.handler(
		postTo("/factor/totp/enroll/start", {}, cookies({ session: sessionToken })),
	);
	const { secretBase32 } = (await started.json()) as { secretBase32: string };
	const finished = await mounted.handler(
		postTo(
			"/factor/totp/enroll/finish",
			{ code: totpCodeNow(secretBase32) },
			cookies({ session: sessionToken }),
		),
	);
	expect([started.status, finished.status]).toStrictEqual([200, 204]);
	clock.advanceBy(2 * ONE_TOTP_STEP_IN_MILLISECONDS);
	fired.length = 0;
	return secretBase32;
}

async function registerAuthenticator(sessionToken: string): Promise<VirtualAuthenticator> {
	const authenticator = await createVirtualAuthenticator({
		relyingPartyId: RELYING_PARTY_ID,
		origin: TEST_ORIGIN,
		flags: { userVerified: true, backupEligible: true, backupState: true },
	});
	const started = await mounted.handler(
		postTo("/factor/webauthn/register/start", {}, cookies({ session: sessionToken })),
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
			cookies({ session: sessionToken }),
		),
	);
	expect([started.status, finished.status]).toStrictEqual([200, 200]);
	return authenticator;
}

function signInWithPassword(email: string, password = PASSWORD): Promise<Response> {
	return mounted.handler(postTo("/sign-in/password", { email, password }));
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

async function mailedMagicLink(email: string): Promise<string> {
	mounted.email.clear();
	const requested = await mounted.handler(postTo("/sign-in/magic-link/request", { email }));
	expect(requested.status).toBe(204);
	const message = mounted.email.messages.find((sent) => sent.kind === "magic_link");
	if (message === undefined || message.kind !== "magic_link") {
		throw new Error("no magic link was sent");
	}
	fired.length = 0;
	return message.token;
}

function redeemMagicLink(token: string): Promise<Response> {
	return mounted.handler(postTo("/sign-in/magic-link/redeem", { token }));
}

function pendingCookieOf(answer: Response): string {
	const pending = cookieIn(answer, DEFAULT_COOKIE_NAMES.pending);
	if (pending === null) {
		throw new Error(`the answer (${answer.status}) wrote no pending cookie`);
	}
	return pending;
}

function verifyTotp(secretBase32: string, pending: string): Promise<Response> {
	return mounted.handler(
		postTo("/factor/totp/verify", { code: totpCodeNow(secretBase32) }, cookies({ pending })),
	);
}

let subjects = 0;

async function oauthCallback(): Promise<Response> {
	const started = await mounted.handler(postTo("/sign-in/oauth/start", { provider: "stubby" }));
	expect(started.status, await started.clone().text()).toBe(200);
	const body = (await started.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string };
	};
	const state = new URL(body.authorizationUrl).searchParams.get("state") ?? "";
	return mounted.handler(
		new Request(
			`https://api.example.com/sign-in/oauth/callback/stubby?code=${codeCarrying(null)}&state=${encodeURIComponent(state)}`,
			{ headers: { Origin: TEST_ORIGIN, ...cookies({ oauthState: body.stateCookie.value }) } },
		),
	);
}

function nextProviderAccount(): string {
	subjects += 1;
	const email = `provider${subjects}@elsewhere.example`;
	provider.reportClaims({ sub: `hooks-subject-${subjects}`, email, email_verified: true });
	return email;
}

const SIGNED_IN_SEQUENCE: readonly SignInPoint[] = [
	"beforeSignIn",
	"beforeSessionCreate",
	"afterSessionCreate",
	"afterSignIn",
];

const COMPLETION_SEQUENCE: readonly SignInPoint[] = [
	"beforeSessionCreate",
	"afterSessionCreate",
	"afterSignIn",
];

const SIGN_UP_SEQUENCE: readonly SignInPoint[] = [
	"beforeUserCreate",
	"afterUserCreate",
	"beforeSessionCreate",
	"afterSessionCreate",
];

describe("password sign-in runs the sign-in and session hooks (3.11, 3.15 G)", () => {
	it("fires each point once, in order, with the events of a password sign-in", async () => {
		const account = await signUp();

		const answer = await signInWithPassword(account.email);
		const sessionToken = cookieIn(answer, DEFAULT_COOKIE_NAMES.session);
		const { session } = (await answer.json()) as { session: { id: string } };

		expect(answer.status).toBe(200);
		expect(sessionToken).not.toBeNull();
		expect(points()).toStrictEqual(SIGNED_IN_SEQUENCE);
		expect(eventAt("beforeSignIn")).toStrictEqual({
			method: "password",
			userId: null,
			ipAddress: null,
			userAgent: null,
		});
		expect(eventAt("beforeSessionCreate")).toStrictEqual({
			userId: account.userId,
			factors: ["password"],
		});
		expect(eventAt("afterSessionCreate")).toStrictEqual({
			userId: account.userId,
			factors: ["password"],
			sessionId: session.id,
		});
		expect(eventAt("afterSignIn")).toStrictEqual({
			method: "password",
			userId: account.userId,
			ipAddress: null,
			userAgent: null,
			sessionId: session.id,
			factors: ["password"],
		});
	});

	it("creates no session when beforeSignIn refuses (S-OWNER-12)", async () => {
		const account = await signUp();
		const before = await sessionRowsOf(account.userId);
		refuseAt = "beforeSignIn";

		const answer = await signInWithPassword(account.email);

		expect(answer.status).toBe(403);
		expect(await answer.json()).toMatchObject({ error: { code: "spy.refused" } });
		expect(cookieIn(answer, DEFAULT_COOKIE_NAMES.session)).toBeNull();
		expect(await sessionRowsOf(account.userId)).toBe(before);
		expect(points()).toStrictEqual(["beforeSignIn"]);
	});

	it("creates no session when beforeSessionCreate refuses", async () => {
		const account = await signUp();
		const before = await sessionRowsOf(account.userId);
		refuseAt = "beforeSessionCreate";

		const answer = await signInWithPassword(account.email);

		expect(answer.status).toBe(403);
		expect(await sessionRowsOf(account.userId)).toBe(before);
		expect(points()).toStrictEqual(["beforeSignIn", "beforeSessionCreate"]);
	});

	it("tells beforeSignIn the same for an existing and a missing account (S-TIM-1)", async () => {
		const account = await signUp();

		const existing = await signInWithPassword(account.email, "not the password");
		const existingEvents = [...fired];
		fired.length = 0;
		const missing = await signInWithPassword(freshAddress(), "not the password");

		expect([existing.status, missing.status]).toStrictEqual([401, 401]);
		expect(existingEvents).toStrictEqual([...fired]);
		expect(points()).toStrictEqual(["beforeSignIn"]);
	});
});

describe("passkey sign-in runs the sign-in and session hooks (3.11, 3.15 G)", () => {
	it("fires each point once, in order, with the events of a passkey sign-in", async () => {
		const account = await signUp();
		const authenticator = await registerAuthenticator(account.sessionToken);
		fired.length = 0;

		const answer = await signInWithPasskey(authenticator);
		const { session } = (await answer.json()) as { session: { id: string } };

		expect(answer.status).toBe(200);
		expect(points()).toStrictEqual(SIGNED_IN_SEQUENCE);
		expect(eventAt("beforeSignIn")).toMatchObject({ method: "passkey", userId: null });
		expect(eventAt("beforeSessionCreate")).toStrictEqual({
			userId: account.userId,
			factors: ["webauthn"],
		});
		expect(eventAt("afterSignIn")).toStrictEqual({
			method: "passkey",
			userId: account.userId,
			ipAddress: null,
			userAgent: null,
			sessionId: session.id,
			factors: ["webauthn"],
			signCountRegressed: false,
		});
	});

	it("creates no session when beforeSignIn or beforeSessionCreate refuses", async () => {
		const account = await signUp();
		const authenticator = await registerAuthenticator(account.sessionToken);
		const before = await sessionRowsOf(account.userId);

		refuseAt = "beforeSignIn";
		const refusedFirst = await signInWithPasskey(authenticator);
		refuseAt = "beforeSessionCreate";
		const refusedSecond = await signInWithPasskey(authenticator);

		expect([refusedFirst.status, refusedSecond.status]).toStrictEqual([403, 403]);
		expect(await sessionRowsOf(account.userId)).toBe(before);
	});
});

describe("magic-link sign-in runs the sign-in and session hooks (3.11, 3.15 G)", () => {
	it("fires each point once, in order, with the events of a magic-link sign-in", async () => {
		const account = await signUp();
		const token = await mailedMagicLink(account.email);

		const answer = await redeemMagicLink(token);
		const { session } = (await answer.json()) as { session: { id: string } };

		expect(answer.status).toBe(200);
		expect(points()).toStrictEqual(SIGNED_IN_SEQUENCE);
		expect(eventAt("beforeSignIn")).toMatchObject({ method: "magic_link", userId: null });
		expect(eventAt("beforeSessionCreate")).toStrictEqual({ userId: account.userId, factors: [] });
		expect(eventAt("afterSignIn")).toMatchObject({
			method: "magic_link",
			userId: account.userId,
			sessionId: session.id,
			factors: [],
		});
	});

	it("refuses at beforeSignIn before the link is spent, so the link still signs in", async () => {
		const account = await signUp();
		const token = await mailedMagicLink(account.email);
		const before = await sessionRowsOf(account.userId);

		refuseAt = "beforeSignIn";
		const refused = await redeemMagicLink(token);
		const afterRefusal = await sessionRowsOf(account.userId);
		refuseAt = null;
		const accepted = await redeemMagicLink(token);

		expect(refused.status).toBe(403);
		expect(afterRefusal).toBe(before);
		expect(accepted.status).toBe(200);
	});

	it("creates no session when beforeSessionCreate refuses", async () => {
		const account = await signUp();
		const token = await mailedMagicLink(account.email);
		refuseAt = "beforeSessionCreate";

		const refused = await redeemMagicLink(token);

		expect(refused.status).toBe(403);
		expect(await sessionRowsOf(account.userId)).toBe(0);
	});
});

describe("second-factor completion runs the session hooks and afterSignIn (3.11, 3.15 G)", () => {
	it("runs beforeSignIn at the password and the rest at the completion, each once", async () => {
		const account = await signUp();
		const secret = await enrolTotp(account.sessionToken);

		const first = await signInWithPassword(account.email);
		const atFirstFactor = points();
		fired.length = 0;
		const completed = await verifyTotp(secret, pendingCookieOf(first));
		const { session } = (await completed.json()) as { session: { id: string } };

		expect(atFirstFactor).toStrictEqual(["beforeSignIn"]);
		expect(completed.status).toBe(200);
		expect(points()).toStrictEqual(COMPLETION_SEQUENCE);
		expect(eventAt("beforeSessionCreate")).toStrictEqual({
			userId: account.userId,
			factors: ["password", "totp"],
		});
		expect(eventAt("afterSignIn")).toMatchObject({
			method: "password",
			userId: account.userId,
			sessionId: session.id,
			factors: ["password", "totp"],
		});
	});

	it("leaves the pending state and creates no session when beforeSessionCreate refuses", async () => {
		const account = await signUp();
		const secret = await enrolTotp(account.sessionToken);
		const before = await sessionRowsOf(account.userId);
		const pending = pendingCookieOf(await signInWithPassword(account.email));

		refuseAt = "beforeSessionCreate";
		const refused = await verifyTotp(secret, pending);
		const afterRefusal = await sessionRowsOf(account.userId);
		refuseAt = null;
		clock.advanceBy(ONE_TOTP_STEP_IN_MILLISECONDS);
		const accepted = await verifyTotp(secret, pending);

		expect(refused.status).toBe(403);
		expect(afterRefusal).toBe(before);
		expect(accepted.status).toBe(200);
	});

	it("reports the magic link as the method of a link completed by a second factor", async () => {
		const account = await signUp();
		const secret = await enrolTotp(account.sessionToken);
		const token = await mailedMagicLink(account.email);

		const first = await redeemMagicLink(token);
		fired.length = 0;
		const completed = await verifyTotp(secret, pendingCookieOf(first));

		expect(completed.status).toBe(200);
		expect(eventAt("afterSignIn")).toMatchObject({ method: "magic_link", factors: ["totp"] });
	});

	it("reports oauth as the method of an OAuth sign-in completed by a second factor", async () => {
		nextProviderAccount();
		const signedUp = await oauthCallback();
		const sessionToken = cookieIn(signedUp, DEFAULT_COOKIE_NAMES.session) ?? "";
		const secret = await enrolTotp(sessionToken);

		const first = await oauthCallback();
		const atFirstFactor = points();
		fired.length = 0;
		const completed = await verifyTotp(secret, pendingCookieOf(first));

		expect(atFirstFactor).toStrictEqual(["beforeSignIn"]);
		expect(completed.status).toBe(200);
		expect(points()).toStrictEqual(COMPLETION_SEQUENCE);
		expect(eventAt("afterSignIn")).toMatchObject({
			method: "oauth",
			factors: ["oauth", "totp"],
		});
	});
});

describe("sign-up runs the user and session hooks (3.11, 3.15 G)", () => {
	it("fires each point once, in order, on a password sign-up and calls no sign-in point", async () => {
		const email = freshAddress();

		const answer = await mounted.handler(postTo("/sign-up", { email, password: PASSWORD }));
		const userId = await userIdOf(email);
		const { session } = (await answer.json()) as { session: { id: string } };

		expect(answer.status).toBe(200);
		expect(points()).toStrictEqual(SIGN_UP_SEQUENCE);
		expect(eventAt("beforeUserCreate")).toStrictEqual({ email, username: null });
		expect(eventAt("afterUserCreate")).toStrictEqual({ email, username: null, userId });
		expect(eventAt("beforeSessionCreate")).toStrictEqual({ userId, factors: ["password"] });
		expect(eventAt("afterSessionCreate")).toStrictEqual({
			userId,
			factors: ["password"],
			sessionId: session.id,
		});
	});

	it("fires each point once, in order, on a passwordless sign-up", async () => {
		const email = freshAddress();

		const answer = await mounted.handler(postTo("/sign-up/passwordless", { email }));
		const userId = await userIdOf(email);

		expect(answer.status).toBe(200);
		expect(points()).toStrictEqual(SIGN_UP_SEQUENCE);
		expect(eventAt("beforeSessionCreate")).toStrictEqual({ userId, factors: [] });
	});

	it.each(["beforeUserCreate", "afterUserCreate", "beforeSessionCreate"] as const)(
		"leaves no account when %s refuses",
		async (point) => {
			const email = freshAddress();
			refuseAt = point;

			const answer = await mounted.handler(postTo("/sign-up", { email, password: PASSWORD }));

			expect(answer.status).toBe(403);
			expect(cookieIn(answer, DEFAULT_COOKIE_NAMES.session)).toBeNull();
			expect(await userIdOf(email)).toBeNull();
		},
	);

	it("runs the same points with the same events for a taken and a free address (S-ENUM-3)", async () => {
		const taken = await signUp();
		const free = freshAddress();

		const onTaken = await mounted.handler(
			postTo("/sign-up", { email: taken.email, password: PASSWORD }),
		);
		const firedOnTaken = fired.map(({ point, event }) => ({ point, event: withoutIds(event) }));
		fired.length = 0;
		const onFree = await mounted.handler(postTo("/sign-up", { email: free, password: PASSWORD }));
		const firedOnFree = fired.map(({ point, event }) => ({ point, event: withoutIds(event) }));

		expect([onTaken.status, onFree.status]).toStrictEqual([200, 200]);
		expect(firedOnTaken.map((entry) => entry.point)).toStrictEqual(SIGN_UP_SEQUENCE);
		expect(firedOnTaken).toStrictEqual(
			firedOnFree.map((entry) => ({
				...entry,
				event: { ...entry.event, ...("email" in entry.event ? { email: taken.email } : {}) },
			})),
		);
	});

	it("fires the user-create points once on an OAuth sign-up", async () => {
		const email = nextProviderAccount();

		const answer = await oauthCallback();

		expect(answer.status).toBe(302);
		expect(points()).toStrictEqual([
			"beforeSignIn",
			"beforeUserCreate",
			"afterUserCreate",
			"beforeSessionCreate",
			"afterSessionCreate",
			"afterSignIn",
		]);
		expect(eventAt("afterUserCreate")).toMatchObject({ email, userId: await userIdOf(email) });
	});
});

function withoutIds(event: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	const { userId: _userId, sessionId: _sessionId, ...rest } = event;
	return rest;
}
