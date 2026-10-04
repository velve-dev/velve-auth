import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { type MountedAuth, mountAuth } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import { createStubProvider, oauthConfigFor, type StubProvider } from "./oauth-provider.js";
import {
	enrolTotp,
	issuedCookieValue,
	oauthCallbackRequest,
	oauthFormPostCallbackRequest,
	oauthStateCookieHeader,
	PROOF_PASSWORD,
	parseSetCookie,
	pendingCookieHeader,
	sessionCookieHeader,
	startOAuthFlow,
	totpCodeNow,
	UNLIMITED_RATES,
} from "./proof-fixtures.js";

const mountedInstances: MountedAuth[] = [];
let clock: TestClock;

/** Every Set-Cookie name any answer of this file carried, and the ones written with a value. */
const written = new Set<string>();
const writtenWithAValue = new Set<string>();
let answersObserved = 0;

function recording(handler: (request: Request) => Promise<Response>) {
	return async (request: Request): Promise<Response> => {
		const answer = await handler(request);
		answersObserved += 1;
		for (const cookie of answer.headers.getSetCookie().map(parseSetCookie)) {
			written.add(cookie.name);
			if (cookie.value !== "") {
				writtenWithAValue.add(cookie.name);
			}
		}
		return answer;
	};
}

async function mountWithProvider(
	prefix: string,
	responseMode: "query" | "form_post",
): Promise<{ handler: (request: Request) => Promise<Response>; provider: StubProvider }> {
	const provider = await createStubProvider({
		claims: { sub: `${prefix}-subject`, email: `${prefix}@example.com`, email_verified: true },
	});
	const mounted = await mountAuth(prefix, {
		clock,
		rateLimit: UNLIMITED_RATES,
		oauth: oauthConfigFor({ openIdConnect: false, responseMode }),
		fetch: provider.fetch,
	});
	mountedInstances.push(mounted);
	return { handler: recording(mounted.handler), provider };
}

let handler: (request: Request) => Promise<Response>;
let formPostHandler: (request: Request) => Promise<Response>;
let provider: StubProvider;

beforeAll(async () => {
	clock = createTestClock(new Date());
	({ handler, provider } = await mountWithProvider("cookieset", "query"));
	({ handler: formPostHandler } = await mountWithProvider("cookieform", "form_post"));
});

afterAll(async () => {
	for (const mounted of mountedInstances) {
		await dropSchema(mounted.connection, mounted.schema);
		await mounted.connection.close();
	}
});

async function passwordSignIn(address: string): Promise<string> {
	const answer = await handler(
		postTo("/sign-in/password", { email: address, password: PROOF_PASSWORD }),
	);
	const pending = issuedCookieValue(answer, DEFAULT_COOKIE_NAMES.pending);
	if (pending === null) {
		throw new Error(`the sign-in answered ${answer.status} without a pending state`);
	}
	return pending;
}

/** The session, the second-factor and the provider flows, each through to its end. */
async function walkEveryCookieWritingFlow(): Promise<readonly number[]> {
	const address = "every-cookie@example.com";
	const signedUp = await handler(postTo("/sign-up", { email: address, password: PROOF_PASSWORD }));
	const session = issuedCookieValue(signedUp, DEFAULT_COOKIE_NAMES.session) ?? "";
	const secretBase32 = await enrolTotp(handler, clock, session);
	await handler(postTo("/session/refresh", {}, { Cookie: sessionCookieHeader(session) }));
	await handler(postTo("/sign-out", {}, { Cookie: sessionCookieHeader(session) }));

	const cancelled = await passwordSignIn(address);
	await handler(postTo("/pending/cancel", {}, { Cookie: pendingCookieHeader(cancelled) }));
	const verified = await handler(
		postTo(
			"/factor/totp/verify",
			{ code: totpCodeNow(secretBase32, clock) },
			{ Cookie: pendingCookieHeader(await passwordSignIn(address)) },
		),
	);
	const secondFactorSession = issuedCookieValue(verified, DEFAULT_COOKIE_NAMES.session) ?? "";

	const signInFlow = await startOAuthFlow(handler, "/sign-in/oauth/start");
	const signedInByProvider = await handler(
		oauthCallbackRequest(signInFlow, [oauthStateCookieHeader(signInFlow.pointer)]),
	);
	provider.reportClaims({ sub: "a-second-subject", email: "linked@example.com" });
	const linkFlow = await startOAuthFlow(
		handler,
		"/identity/link/start",
		sessionCookieHeader(secondFactorSession),
	);
	const linked = await handler(
		oauthCallbackRequest(linkFlow, [
			oauthStateCookieHeader(linkFlow.pointer),
			sessionCookieHeader(secondFactorSession),
		]),
	);

	const formPostFlow = await startOAuthFlow(formPostHandler, "/sign-in/oauth/start");
	const postedBack = await formPostHandler(
		oauthFormPostCallbackRequest(formPostFlow, [oauthStateCookieHeader(formPostFlow.pointer)]),
	);
	return [verified.status, signedInByProvider.status, linked.status, postedBack.status];
}

describe("every cookie set is an enumerated one, and every enumerated one is set (S-COOKIE-6, T-COOKIE-6)", () => {
	it("collects exactly the three enumerated names over the session, pending and provider flows", async () => {
		expect(await walkEveryCookieWritingFlow()).toStrictEqual([200, 302, 302, 302]);
		const enumerated = Object.values(DEFAULT_COOKIE_NAMES).sort();

		expect(answersObserved).toBeGreaterThan(10);
		expect([...written].filter((name) => !enumerated.includes(name))).toStrictEqual([]);
		expect(enumerated.filter((name) => !written.has(name))).toStrictEqual([]);
		expect([...writtenWithAValue].sort()).toStrictEqual(enumerated);
		expect(enumerated).toStrictEqual([
			"__Host-velve_oauth_state",
			"__Host-velve_pending",
			"__Host-velve_session",
		]);
	});
});
