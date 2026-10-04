import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_LEVEL_EVENTS, type TrustLevelEvent } from "../src/core/auth/trust-level.js";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
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
 * T-FIX-1 and T-FIX-3 over the mounted handler. Every event of `TRUST_LEVEL_EVENTS` is sent with
 * the browser's existing session cookie T1; the answer must carry a new T2, T1's row must be gone
 * (S-FIX-1), and T1 must then read exactly like no cookie at all (S-FIX-3).
 */

const PASSWORD = "correct-horse-battery-staple";
const REPLACEMENT = "a different password entirely";
const RELYING_PARTY_ID = "app.example.com";
const ONE_TOTP_STEP_IN_MILLISECONDS = 30_000;

let mounted: MountedAuth;
let clock: TestClock;
let provider: StubProvider;

beforeAll(async () => {
	clock = createTestClock();
	provider = await createStubProvider({
		claims: { sub: "unused", email: "unused@example.com", email_verified: true },
	});
	mounted = await mountAuth("signinreplaces", {
		clock,
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

function sessionCookieOf(answer: Response): string {
	const token = cookieIn(answer, DEFAULT_COOKIE_NAMES.session);
	if (token === null) {
		throw new Error(`the answer (${answer.status}) wrote no session cookie`);
	}
	return token;
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

function getFrom(path: string, headers: Record<string, string> = {}): Request {
	return new Request(`https://api.example.com${path}`, {
		headers: { Origin: TEST_ORIGIN, ...headers },
	});
}

let accounts = 0;

async function signUp(): Promise<{ email: string; sessionToken: string }> {
	accounts += 1;
	const email = `replaces${accounts}@example.com`;
	const answer = await mounted.handler(postTo("/sign-up", { email, password: PASSWORD }));
	expect(answer.status).toBe(200);
	return { email, sessionToken: sessionCookieOf(answer) };
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
	// S-REPLAY-4 refuses the step the enrolment claimed, so the sign-in uses a later one.
	clock.advanceBy(2 * ONE_TOTP_STEP_IN_MILLISECONDS);
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

/** A password sign-in that stops at the intermediate state, still carrying the browser's T1. */
async function pendingTokenAfterPassword(email: string, presented: string): Promise<string> {
	const answer = await mounted.handler(
		postTo("/sign-in/password", { email, password: PASSWORD }, cookies({ session: presented })),
	);
	const body = (await answer.json()) as { status: string };
	expect(body.status).toBe("second_factor_required");
	const pendingToken = cookieIn(answer, DEFAULT_COOKIE_NAMES.pending);
	if (pendingToken === null) {
		throw new Error("the intermediate state reached no cookie");
	}
	return pendingToken;
}

async function oauthCallback(input: {
	readonly startPath: string;
	readonly startCookie?: string;
	readonly presented?: string;
}): Promise<Response> {
	const started = await mounted.handler(
		postTo(
			input.startPath,
			{ provider: "stubby" },
			input.startCookie === undefined ? {} : cookies({ session: input.startCookie }),
		),
	);
	expect(started.status, await started.clone().text()).toBe(200);
	const body = (await started.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string };
	};
	const state = new URL(body.authorizationUrl).searchParams.get("state") ?? "";
	return mounted.handler(
		getFrom(
			`/sign-in/oauth/callback/stubby?code=${codeCarrying(null)}&state=${encodeURIComponent(state)}`,
			cookies({
				oauthState: body.stateCookie.value,
				...(input.presented === undefined ? {} : { session: input.presented }),
			}),
		),
	);
}

let subjects = 0;

function nextProviderAccount(): void {
	subjects += 1;
	provider.reportClaims({
		sub: `replaces-subject-${subjects}`,
		email: `provider${subjects}@elsewhere.example`,
		email_verified: true,
	});
}

/** What the browser presents as T1, and the request that carries the event with it. */
interface Arranged {
	readonly presented: string;
	readonly send: () => Promise<Response>;
}

const ARRANGEMENTS: Readonly<Record<TrustLevelEvent, () => Promise<Arranged>>> = {
	async sign_in_password() {
		const account = await signUp();
		return {
			presented: account.sessionToken,
			send: () =>
				mounted.handler(
					postTo(
						"/sign-in/password",
						{ email: account.email, password: PASSWORD },
						cookies({ session: account.sessionToken }),
					),
				),
		};
	},

	async sign_in_passkey() {
		const account = await signUp();
		const authenticator = await registerAuthenticator(account.sessionToken);
		return {
			presented: account.sessionToken,
			async send() {
				const started = await mounted.handler(postTo("/sign-in/passkey/start", {}));
				const { challengeToken } = (await started.json()) as { challengeToken: string };
				return mounted.handler(
					postTo(
						"/sign-in/passkey/finish",
						{
							challengeToken,
							response: await authenticator.assert({ challenge: challengeToken }),
						},
						cookies({ session: account.sessionToken }),
					),
				);
			},
		};
	},

	async second_factor_totp() {
		const account = await signUp();
		const secretBase32 = await enrolTotp(account.sessionToken);
		return {
			presented: account.sessionToken,
			async send() {
				const pendingToken = await pendingTokenAfterPassword(account.email, account.sessionToken);
				return mounted.handler(
					postTo(
						"/factor/totp/verify",
						{ code: totpCodeNow(secretBase32) },
						cookies({ session: account.sessionToken, pending: pendingToken }),
					),
				);
			},
		};
	},

	async second_factor_webauthn() {
		const account = await signUp();
		const authenticator = await registerAuthenticator(account.sessionToken);
		return {
			presented: account.sessionToken,
			async send() {
				const pendingToken = await pendingTokenAfterPassword(account.email, account.sessionToken);
				const withBoth = cookies({ session: account.sessionToken, pending: pendingToken });
				const started = await mounted.handler(
					postTo("/factor/webauthn/authenticate/start", {}, withBoth),
				);
				const { challengeToken } = (await started.json()) as { challengeToken: string };
				return mounted.handler(
					postTo(
						"/factor/webauthn/authenticate/finish",
						{
							challengeToken,
							response: await authenticator.assert({ challenge: challengeToken }),
						},
						withBoth,
					),
				);
			},
		};
	},

	async second_factor_recovery_code() {
		const account = await signUp();
		await enrolTotp(account.sessionToken);
		const generated = await mounted.handler(
			postTo("/factor/recovery/generate", {}, cookies({ session: account.sessionToken })),
		);
		const { codes } = (await generated.json()) as { codes: readonly string[] };
		return {
			presented: account.sessionToken,
			async send() {
				const pendingToken = await pendingTokenAfterPassword(account.email, account.sessionToken);
				return mounted.handler(
					postTo(
						"/factor/recovery/verify",
						{ code: codes[0] },
						cookies({ session: account.sessionToken, pending: pendingToken }),
					),
				);
			},
		};
	},

	async password_change() {
		const account = await signUp();
		return {
			presented: account.sessionToken,
			send: () =>
				mounted.handler(
					postTo(
						"/password/change",
						{ currentPassword: PASSWORD, newPassword: REPLACEMENT },
						cookies({ session: account.sessionToken }),
					),
				),
		};
	},

	async password_reset() {
		const account = await signUp();
		mounted.email.clear();
		const requested = await mounted.handler(
			postTo("/password/request-reset", { email: account.email }),
		);
		expect(requested.status).toBe(204);
		const message = mounted.email.messages.find((sent) => sent.kind === "password_reset");
		if (message === undefined || message.kind !== "password_reset") {
			throw new Error("no reset message was sent");
		}
		return {
			presented: account.sessionToken,
			send: () =>
				mounted.handler(
					postTo(
						"/password/redeem-reset",
						{ token: message.token, newPassword: REPLACEMENT },
						cookies({ session: account.sessionToken }),
					),
				),
		};
	},

	async identity_linked() {
		const account = await signUp();
		nextProviderAccount();
		return {
			presented: account.sessionToken,
			send: () =>
				oauthCallback({
					startPath: "/identity/link/start",
					startCookie: account.sessionToken,
					presented: account.sessionToken,
				}),
		};
	},
};

function sha256Of(token: string): Buffer {
	return createHash("sha256").update(token, "utf8").digest();
}

async function rowsHashedFrom(token: string): Promise<number> {
	const [row] = await mounted.connection.query<{ count: number }>(
		`SELECT count(*)::int AS count FROM ${mounted.schema}.session WHERE token_sha256 = $1`,
		[sha256Of(token)],
	);
	return row?.count ?? -1;
}

/** Status, every header but the date, and the body as raw bytes: nothing is normalised away. */
async function exactAnswer(answer: Response): Promise<string> {
	const headers = [...answer.headers]
		.filter(([name]) => name !== "date")
		.map(([name, value]) => `${name}: ${value}`)
		.sort()
		.join("\n");
	const body = Buffer.from(await answer.arrayBuffer()).toString("hex");
	return `${answer.status}\n${headers}\n${body}`;
}

async function assertReplaced(arranged: Arranged): Promise<void> {
	const t1 = arranged.presented;
	expect(await rowsHashedFrom(t1)).toBe(1);

	const answer = await arranged.send();
	expect(answer.status, await answer.clone().text()).toBeLessThan(400);
	const t2 = sessionCookieOf(answer);

	const withT1 = await mounted.handler(getFrom("/session", cookies({ session: t1 })));
	const withoutCookie = await mounted.handler(getFrom("/session"));

	expect(t2).not.toBe(t1);
	expect(await rowsHashedFrom(t1)).toBe(0);
	expect(await rowsHashedFrom(t2)).toBe(1);
	expect(await exactAnswer(withT1)).toBe(await exactAnswer(withoutCookie));
}

describe("every trust-level event replaces the session the browser presented (T-FIX-1, T-FIX-3)", () => {
	it("has exactly one case for each event of TRUST_LEVEL_EVENTS", () => {
		expect(Object.keys(ARRANGEMENTS)).toHaveLength(TRUST_LEVEL_EVENTS.length);
		expect(Object.keys(ARRANGEMENTS).sort()).toStrictEqual([...TRUST_LEVEL_EVENTS].sort());
	});

	it.each(TRUST_LEVEL_EVENTS)(
		"%s writes T2, leaves no row for T1, and T1 reads like no cookie (S-FIX-1, S-FIX-3)",
		async (event) => {
			await assertReplaced(await ARRANGEMENTS[event]());
		},
	);
});

/**
 * S-FIX-1 says every sign-in, and two ways in are not in `TRUST_LEVEL_EVENTS`: the magic link and
 * the provider sign-in. They set the same cookie, so they replace the same row.
 */
describe("the sign-ins outside TRUST_LEVEL_EVENTS replace the presented session too (S-FIX-1)", () => {
	it("a magic link", async () => {
		const account = await signUp();
		mounted.email.clear();
		const requested = await mounted.handler(
			postTo("/sign-in/magic-link/request", { email: account.email }),
		);
		expect(requested.status).toBe(204);
		const message = mounted.email.messages.find((sent) => sent.kind === "magic_link");
		if (message === undefined || message.kind !== "magic_link") {
			throw new Error("no magic link was sent");
		}
		await assertReplaced({
			presented: account.sessionToken,
			send: () =>
				mounted.handler(
					postTo(
						"/sign-in/magic-link/redeem",
						{ token: message.token },
						cookies({ session: account.sessionToken }),
					),
				),
		});
	});

	it("a provider sign-in", async () => {
		nextProviderAccount();
		const first = await oauthCallback({ startPath: "/sign-in/oauth/start" });
		const presented = sessionCookieOf(first);
		await assertReplaced({
			presented,
			send: () => oauthCallback({ startPath: "/sign-in/oauth/start", presented }),
		});
	});
});

/**
 * The row the browser presented goes even when it belongs to someone else: the answer overwrites
 * the cookie in this browser, so a row left standing would be a live session nobody holds.
 */
describe("a presented session of another account is replaced as well", () => {
	it("a password sign-in into account A removes account B's presented row", async () => {
		const accountA = await signUp();
		const accountB = await signUp();
		await assertReplaced({
			presented: accountB.sessionToken,
			send: () =>
				mounted.handler(
					postTo(
						"/sign-in/password",
						{ email: accountA.email, password: PASSWORD },
						cookies({ session: accountB.sessionToken }),
					),
				),
		});
		expect(await rowsHashedFrom(accountA.sessionToken)).toBe(1);
	});

	it("a password reset of account A removes account B's presented row", async () => {
		const accountA = await signUp();
		const accountB = await signUp();
		mounted.email.clear();
		await mounted.handler(postTo("/password/request-reset", { email: accountA.email }));
		const message = mounted.email.messages.find((sent) => sent.kind === "password_reset");
		if (message === undefined || message.kind !== "password_reset") {
			throw new Error("no reset message was sent");
		}
		await assertReplaced({
			presented: accountB.sessionToken,
			send: () =>
				mounted.handler(
					postTo(
						"/password/redeem-reset",
						{ token: message.token, newPassword: REPLACEMENT },
						cookies({ session: accountB.sessionToken }),
					),
				),
		});
	});
});
