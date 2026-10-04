import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { decodeBase64Url } from "../src/core/keys/base64url.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { type MountedAuth, mountAuth, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import { createStubProvider, oauthConfigFor } from "./oauth-provider.js";
import {
	enrolTotp,
	issuedCookieValue,
	oauthCallbackRequest,
	oauthStateCookieHeader,
	PROOF_PASSWORD,
	pendingCookieHeader,
	sessionCookieHeader,
	startOAuthFlow,
	totpCodeNow,
	UNLIMITED_RATES,
} from "./proof-fixtures.js";
import { createVirtualAuthenticator } from "./webauthn-simulator.js";

let mounted: MountedAuth;
let clock: TestClock;
let accounts = 0;

const RELYING_PARTY_ID = "app.example.com";

beforeAll(async () => {
	clock = createTestClock(new Date());
	const provider = await createStubProvider({
		claims: { sub: "session-value-subject", email: "provider@example.com", email_verified: true },
	});
	mounted = await mountAuth("sessionvalue", {
		clock,
		rateLimit: UNLIMITED_RATES,
		oauth: oauthConfigFor({ openIdConnect: false }),
		fetch: provider.fetch,
		webauthn: {
			relyingPartyId: RELYING_PARTY_ID,
			relyingPartyName: "Velve Auth tests",
			origins: [TEST_ORIGIN],
			userVerification: "required",
		},
		recoveryCodes: { count: 10, groupSize: 5 },
	});
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

/** One base64url token of 32 bytes is 43 characters without padding (3.5). */
const ONE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SEPARATORS = /[.|,:;=]/;

function nextAddress(): string {
	accounts += 1;
	return `session-value${accounts}@example.com`;
}

function lastTokenSentTo(address: string): string {
	const message = [...mounted.email.messages].reverse().find((sent) => sent.to === address);
	if (message === undefined || !("token" in message)) {
		throw new Error(`no token was sent to ${address}`);
	}
	return message.token;
}

async function signUp(address: string): Promise<Response> {
	return mounted.handler(postTo("/sign-up", { email: address, password: PROOF_PASSWORD }));
}

async function sessionOf(answer: Response): Promise<string> {
	const token = issuedCookieValue(answer, DEFAULT_COOKIE_NAMES.session);
	if (token === null) {
		throw new Error(`the answer (${answer.status}) set no session cookie`);
	}
	return token;
}

async function signedUpSession(address: string): Promise<string> {
	return sessionOf(await signUp(address));
}

type SessionIssuingRoute = readonly [name: string, issue: () => Promise<Response>];

const SESSION_ISSUING_ROUTES: readonly SessionIssuingRoute[] = [
	["POST /sign-up", () => signUp(nextAddress())],
	[
		"POST /sign-in/password",
		async () => {
			const address = nextAddress();
			await signUp(address);
			return mounted.handler(
				postTo("/sign-in/password", { email: address, password: PROOF_PASSWORD }),
			);
		},
	],
	[
		"POST /sign-in/magic-link/redeem",
		async () => {
			const address = nextAddress();
			await signUp(address);
			await mounted.handler(postTo("/sign-in/magic-link/request", { email: address }));
			return mounted.handler(
				postTo("/sign-in/magic-link/redeem", { token: lastTokenSentTo(address) }),
			);
		},
	],
	[
		"POST /factor/totp/verify",
		async () => {
			const address = nextAddress();
			const secretBase32 = await enrolTotp(
				mounted.handler,
				clock,
				await sessionOf(await signUp(address)),
			);
			const pending = await mounted.handler(
				postTo("/sign-in/password", { email: address, password: PROOF_PASSWORD }),
			);
			return mounted.handler(
				postTo(
					"/factor/totp/verify",
					{ code: totpCodeNow(secretBase32, clock) },
					{
						Cookie: pendingCookieHeader(
							issuedCookieValue(pending, DEFAULT_COOKIE_NAMES.pending) ?? "",
						),
					},
				),
			);
		},
	],
	[
		"POST /password/redeem-reset",
		async () => {
			const address = nextAddress();
			await signUp(address);
			await mounted.handler(postTo("/password/request-reset", { email: address }));
			return mounted.handler(
				postTo("/password/redeem-reset", {
					token: lastTokenSentTo(address),
					newPassword: "another-password-of-length",
				}),
			);
		},
	],
	[
		"POST /password/change",
		async () => {
			const address = nextAddress();
			const session = await sessionOf(await signUp(address));
			return mounted.handler(
				postTo(
					"/password/change",
					{ currentPassword: PROOF_PASSWORD, newPassword: "another-password-of-length" },
					{ Cookie: sessionCookieHeader(session) },
				),
			);
		},
	],
	[
		"POST /sign-in/passkey/finish",
		async () => {
			const session = await signedUpSession(nextAddress());
			const authenticator = await createVirtualAuthenticator({
				relyingPartyId: RELYING_PARTY_ID,
				origin: TEST_ORIGIN,
				flags: { userVerified: true, backupEligible: true, backupState: true },
			});
			const withSession = { Cookie: sessionCookieHeader(session) };
			const registering = await mounted.handler(
				postTo("/factor/webauthn/register/start", {}, withSession),
			);
			const registration = (await registering.json()) as { challengeToken: string };
			await mounted.handler(
				postTo(
					"/factor/webauthn/register/finish",
					{
						challengeToken: registration.challengeToken,
						response: await authenticator.attest({ challenge: registration.challengeToken }),
						label: "A key",
					},
					withSession,
				),
			);
			const started = await mounted.handler(postTo("/sign-in/passkey/start", {}));
			const { challengeToken } = (await started.json()) as { challengeToken: string };
			return mounted.handler(
				postTo("/sign-in/passkey/finish", {
					challengeToken,
					response: await authenticator.assert({ challenge: challengeToken }),
				}),
			);
		},
	],
	[
		"POST /password/redeem-reset-with-recovery-code",
		async () => {
			const address = nextAddress();
			const session = await signedUpSession(address);
			const generated = await mounted.handler(
				postTo("/factor/recovery/generate", {}, { Cookie: sessionCookieHeader(session) }),
			);
			const { codes } = (await generated.json()) as { codes: string[] };
			return mounted.handler(
				postTo("/password/redeem-reset-with-recovery-code", {
					email: address,
					recoveryCode: codes[0] ?? "",
					newPassword: "another-password-of-length",
				}),
			);
		},
	],
	[
		"GET /sign-in/oauth/callback/:provider",
		async () => {
			const flow = await startOAuthFlow(mounted.handler, "/sign-in/oauth/start");
			return mounted.handler(oauthCallbackRequest(flow, [oauthStateCookieHeader(flow.pointer)]));
		},
	],
];

describe("the session cookie carries the token and nothing else (S-COOKIE-4, T-COOKIE-4)", () => {
	it.each(SESSION_ISSUING_ROUTES)(
		"%s sets exactly one 32-byte base64url token",
		async (_, issue) => {
			const answer = await issue();
			const written = answer.headers
				.getSetCookie()
				.filter((header) => header.startsWith(`${DEFAULT_COOKIE_NAMES.session}=`));
			const value = await sessionOf(answer);

			expect(answer.status).toBeLessThan(400);
			expect(written).toHaveLength(1);
			expect(value).toMatch(ONE_TOKEN);
			expect(SEPARATORS.test(value)).toBe(false);
			expect(decodeBase64Url(value)).toHaveLength(32);
		},
	);

	it("refuses a value that is anything more than one token, so the checks above can fail", () => {
		const token = "A".repeat(43);
		const carrying = [`${token}.eyJ1c2VyIjoxfQ`, `${token}|totp`, `${token},1`, token.slice(1)];

		for (const value of carrying) {
			expect([value, ONE_TOKEN.test(value)]).toStrictEqual([value, false]);
		}
	});
});
