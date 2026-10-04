import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { type MountedAuth, mountAuth, requestTo, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import { codeCarrying, createStubProvider, oauthConfigFor } from "./oauth-provider.js";
import { drawTestPassword } from "./password-fixtures.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";
import { createVirtualAuthenticator, type VirtualAuthenticator } from "./webauthn-simulator.js";

const SESSION_COOKIE = "__Host-velve_session";
const REQUIRED_ATTRIBUTES = ["HttpOnly", "Path=/", "SameSite=Lax", "Secure"];
const ONE_TOTP_STEP_IN_MILLISECONDS = 30_000;
const PASSWORD = drawTestPassword();

let mounted: MountedAuth;
let clock: TestClock;

/** Every route that answers with a fresh session, and the `Set-Cookie` lines it wrote. */
const observed = new Map<string, readonly string[]>();

beforeAll(async () => {
	clock = createTestClock();
	const provider = await createStubProvider({
		claims: { sub: "fix-5-subject", email: "oauth@example.com", email_verified: true },
	});
	mounted = await mountAuth("fixcookie", {
		clock,
		webauthn: {
			relyingPartyId: "app.example.com",
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
}, 60_000);

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

function cookieValue(answer: Response, name: string): string {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === name && separator < pair.length - 1) {
			return pair.slice(separator + 1);
		}
	}
	throw new Error(`no ${name} was set (${answer.status})`);
}

/** Records the answer of a session-creating route and hands its session token on. */
function sessionOf(route: string, answer: Response): string {
	expect(answer.status, route).toBeLessThan(400);
	observed.set(route, answer.headers.getSetCookie());
	return cookieValue(answer, SESSION_COOKIE);
}

function withSession(token: string): Record<string, string> {
	return { Cookie: `${DEFAULT_COOKIE_NAMES.session}=${token}` };
}

function withPending(token: string): Record<string, string> {
	return { Cookie: `${DEFAULT_COOKIE_NAMES.pending}=${token}` };
}

function lastMessage(kind: EmailMessage["kind"]): EmailMessage & { token: string } {
	const message = mounted.email.messages.filter((sent) => sent.kind === kind).at(-1);
	if (message === undefined || !("token" in message)) {
		throw new Error(`no ${kind} was sent`);
	}
	return message;
}

async function signUp(email: string): Promise<string> {
	return sessionOf(
		"POST /sign-up",
		await mounted.handler(postTo("/sign-up", { email, password: PASSWORD })),
	);
}

async function pendingAfterPassword(email: string): Promise<string> {
	const answer = await mounted.handler(postTo("/sign-in/password", { email, password: PASSWORD }));
	expect(answer.status).toBe(200);
	return cookieValue(answer, DEFAULT_COOKIE_NAMES.pending);
}

function codeNow(secretBase32: string): string {
	return totpCodeForStep(secretBytesOfBase32(secretBase32), timeStepAt(clock.now()));
}

async function enrolTotp(sessionToken: string): Promise<string> {
	const started = await mounted.handler(
		postTo("/factor/totp/enroll/start", {}, withSession(sessionToken)),
	);
	const { secretBase32 } = (await started.json()) as { secretBase32: string };
	const finished = await mounted.handler(
		postTo(
			"/factor/totp/enroll/finish",
			{ code: codeNow(secretBase32) },
			withSession(sessionToken),
		),
	);
	expect([started.status, finished.status]).toStrictEqual([200, 204]);
	clock.advanceBy(2 * ONE_TOTP_STEP_IN_MILLISECONDS);
	return secretBase32;
}

async function registerPasskey(sessionToken: string): Promise<VirtualAuthenticator> {
	const authenticator = await createVirtualAuthenticator({
		relyingPartyId: "app.example.com",
		origin: TEST_ORIGIN,
		flags: { userVerified: true, backupEligible: true, backupState: true },
	});
	const started = await mounted.handler(
		postTo("/factor/webauthn/register/start", {}, withSession(sessionToken)),
	);
	const { challengeToken } = (await started.json()) as { challengeToken: string };
	const finished = await mounted.handler(
		postTo(
			"/factor/webauthn/register/finish",
			{
				challengeToken,
				response: await authenticator.attest({ challenge: challengeToken }),
				label: "key",
			},
			withSession(sessionToken),
		),
	);
	expect([started.status, finished.status]).toStrictEqual([200, 200]);
	return authenticator;
}

async function walkEverySessionCreatingRoute(): Promise<void> {
	const plain = await signUp("plain@example.com");
	await mounted
		.handler(postTo("/sign-up", { email: "plain@example.com", password: PASSWORD }))
		.then((answer) => sessionOf("POST /sign-up, address already taken", answer));
	sessionOf(
		"POST /sign-in/password",
		await mounted.handler(
			postTo("/sign-in/password", { email: "plain@example.com", password: PASSWORD }),
		),
	);
	const replaced = sessionOf(
		"POST /sign-in/password, presenting a session",
		await mounted.handler(
			postTo(
				"/sign-in/password",
				{ email: "plain@example.com", password: PASSWORD },
				withSession(plain),
			),
		),
	);
	const changed = sessionOf(
		"POST /password/change",
		await mounted.handler(
			postTo(
				"/password/change",
				{ currentPassword: PASSWORD, newPassword: PASSWORD },
				withSession(replaced),
			),
		),
	);

	await mounted.handler(postTo("/password/request-reset", { email: "plain@example.com" }));
	sessionOf(
		"POST /password/redeem-reset",
		await mounted.handler(
			postTo("/password/redeem-reset", {
				token: lastMessage("password_reset").token,
				newPassword: PASSWORD,
			}),
		),
	);
	await mounted.handler(postTo("/sign-in/magic-link/request", { email: "plain@example.com" }));
	sessionOf(
		"POST /sign-in/magic-link/redeem",
		await mounted.handler(
			postTo(
				"/sign-in/magic-link/redeem",
				{ token: lastMessage("magic_link").token },
				withSession(changed),
			),
		),
	);

	const passwordless = sessionOf(
		"POST /sign-up/passwordless",
		await mounted.handler(postTo("/sign-up/passwordless", { email: "passwordless@example.com" })),
	);
	sessionOf(
		"POST /password/set",
		await mounted.handler(
			postTo("/password/set", { newPassword: PASSWORD }, withSession(passwordless)),
		),
	);

	const secretBase32 = await enrolTotp(await signUp("totp@example.com"));
	sessionOf(
		"POST /factor/totp/verify",
		await mounted.handler(
			postTo(
				"/factor/totp/verify",
				{ code: codeNow(secretBase32) },
				withPending(await pendingAfterPassword("totp@example.com")),
			),
		),
	);
	const totpSession = await signUp("recovery@example.com");
	await enrolTotp(totpSession);
	const generated = await mounted.handler(
		postTo("/factor/recovery/generate", {}, withSession(totpSession)),
	);
	const { codes } = (await generated.json()) as { codes: readonly string[] };
	sessionOf(
		"POST /factor/recovery/verify",
		await mounted.handler(
			postTo(
				"/factor/recovery/verify",
				{ code: codes[0] },
				withPending(await pendingAfterPassword("recovery@example.com")),
			),
		),
	);
	sessionOf(
		"POST /password/redeem-reset-with-recovery-code",
		await mounted.handler(
			postTo("/password/redeem-reset-with-recovery-code", {
				email: "recovery@example.com",
				recoveryCode: codes[1],
				newPassword: PASSWORD,
			}),
		),
	);

	const authenticator = await registerPasskey(await signUp("passkey@example.com"));
	const passkeyStart = await mounted.handler(postTo("/sign-in/passkey/start", {}));
	const passkeyChallenge = ((await passkeyStart.json()) as { challengeToken: string })
		.challengeToken;
	sessionOf(
		"POST /sign-in/passkey/finish",
		await mounted.handler(
			postTo("/sign-in/passkey/finish", {
				challengeToken: passkeyChallenge,
				response: await authenticator.assert({ challenge: passkeyChallenge }),
			}),
		),
	);
	const pending = withPending(await pendingAfterPassword("passkey@example.com"));
	const factorStart = await mounted.handler(
		postTo("/factor/webauthn/authenticate/start", {}, pending),
	);
	const factorChallenge = ((await factorStart.json()) as { challengeToken: string }).challengeToken;
	sessionOf(
		"POST /factor/webauthn/authenticate/finish",
		await mounted.handler(
			postTo(
				"/factor/webauthn/authenticate/finish",
				{
					challengeToken: factorChallenge,
					response: await authenticator.assert({ challenge: factorChallenge }),
				},
				pending,
			),
		),
	);

	const oauthStart = await mounted.handler(
		requestTo("/sign-in/oauth/start", { body: { provider: "stubby" } }),
	);
	const started = (await oauthStart.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string };
	};
	const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
	sessionOf(
		"GET /sign-in/oauth/callback/:provider",
		await mounted.handler(
			requestTo(
				`/sign-in/oauth/callback/stubby?code=${codeCarrying(null)}&state=${encodeURIComponent(state)}`,
				{ method: "GET", cookie: `__Host-velve_oauth_state=${started.stateCookie.value}` },
			),
		),
	);
}

describe("T-FIX-5 — every response that creates a session writes one cookie, one way (S-FIX-5)", () => {
	beforeAll(walkEverySessionCreatingRoute, 120_000);

	it("walked every session-creating route", () => {
		expect([...observed.keys()]).toStrictEqual([
			"POST /sign-up",
			"POST /sign-up, address already taken",
			"POST /sign-in/password",
			"POST /sign-in/password, presenting a session",
			"POST /password/change",
			"POST /password/redeem-reset",
			"POST /sign-in/magic-link/redeem",
			"POST /sign-up/passwordless",
			"POST /password/set",
			"POST /factor/totp/verify",
			"POST /factor/recovery/verify",
			"POST /password/redeem-reset-with-recovery-code",
			"POST /sign-in/passkey/finish",
			"POST /factor/webauthn/authenticate/finish",
			"GET /sign-in/oauth/callback/:provider",
		]);
	});

	it("writes exactly one session entry with HttpOnly, Secure, SameSite=Lax, Path=/ and no Domain", () => {
		const deviations: string[] = [];
		for (const [route, lines] of observed) {
			const entries = lines.filter((line) => line.startsWith(`${SESSION_COOKIE}=`));
			if (entries.length !== 1) {
				deviations.push(`${route}: ${entries.length} session entries`);
				continue;
			}
			const [, ...attributes] = (entries[0] as string).split("; ");
			const maxAge = attributes.filter((attribute) => /^Max-Age=\d+$/.test(attribute));
			const rest = attributes.filter((attribute) => !maxAge.includes(attribute)).sort();
			if (maxAge.length !== 1 || JSON.stringify(rest) !== JSON.stringify(REQUIRED_ATTRIBUTES)) {
				deviations.push(`${route}: ${attributes.join("; ")}`);
			}
			if (attributes.some((attribute) => /^domain=/i.test(attribute))) {
				deviations.push(`${route}: carries a Domain`);
			}
		}
		expect(deviations).toStrictEqual([]);
	});
});
