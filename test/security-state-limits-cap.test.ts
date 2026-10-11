import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { DEFAULT_LIMITS } from "../src/core/security-state/limits.js";
import { type MountedAuth, mountAuth, requestTo, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import {
	codeCarrying,
	createStubProvider,
	oauthConfigFor,
	type StubProvider,
} from "./oauth-provider.js";
import { createVirtualAuthenticator } from "./webauthn-simulator.js";

//an account holds at most the configured passkeys and identities and the check at the cap stays bounded (S-INTEG-10)

const PASSWORD = "a password long enough for the policy 51ce";
const RELYING_PARTY_ID = "app.example.com";
const WARM_UP = 100;
const MEASURED = 1000;

let mounted: MountedAuth;
let provider: StubProvider;

beforeAll(async () => {
	provider = await createStubProvider({
		claims: { sub: "unused", email: "unused@example.com", email_verified: true },
	});
	mounted = await mountAuth("integlimitscap", {
		webauthn: {
			relyingPartyId: RELYING_PARTY_ID,
			relyingPartyName: "Velve Auth tests",
			origins: [TEST_ORIGIN],
			userVerification: "required",
		},
		oauth: oauthConfigFor({ openIdConnect: false }),
		fetch: provider.fetch,
		rateLimit: {
			perIpAddress: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
			perAccount: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
		},
	});
}, 120_000);

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

function sessionOf(answer: Response): string {
	for (const header of answer.headers.getSetCookie()) {
		const [pair = ""] = header.split(";");
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === DEFAULT_COOKIE_NAMES.session) {
			return pair.slice(separator + 1);
		}
	}
	throw new Error("no session cookie");
}

function withSession(token: string): Record<string, string> {
	return { Cookie: `${DEFAULT_COOKIE_NAMES.session}=${token}` };
}

async function signUp(email: string): Promise<{ userId: string; session: string }> {
	const answer = await mounted.handler(postTo("/sign-up", { email, password: PASSWORD }));
	expect(answer.status).toBe(200);
	const userId = ((await answer.json()) as { user: { id: string } }).user.id;
	return { userId, session: sessionOf(answer) };
}

async function registerPasskey(session: string): Promise<Response> {
	const authenticator = await createVirtualAuthenticator({
		relyingPartyId: RELYING_PARTY_ID,
		origin: TEST_ORIGIN,
		flags: { userVerified: true, backupEligible: true, backupState: true },
	});
	const started = await mounted.handler(
		postTo("/factor/webauthn/register/start", {}, withSession(session)),
	);
	const { challengeToken } = (await started.json()) as { challengeToken: string };
	return mounted.handler(
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
}

async function linkIdentity(session: string, subject: string): Promise<Response> {
	provider.reportClaims({ sub: subject, email: `${subject}@provider.example` });
	const started = await mounted.handler(
		requestTo("/identity/link/start", {
			body: { provider: "stubby" },
			cookie: `${DEFAULT_COOKIE_NAMES.session}=${session}`,
		}),
	);
	expect(started.status).toBe(200);
	const body = (await started.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string };
	};
	const state = new URL(body.authorizationUrl).searchParams.get("state") ?? "";
	return mounted.handler(
		requestTo(
			`/sign-in/oauth/callback/stubby?code=${codeCarrying(null)}&state=${encodeURIComponent(state)}`,
			{
				method: "GET",
				cookie: `${DEFAULT_COOKIE_NAMES.oauthState}=${body.stateCookie.value}; ${DEFAULT_COOKIE_NAMES.session}=${session}`,
			},
		),
	);
}

async function errorCodeOf(answer: Response): Promise<string | undefined> {
	const body = (await answer.json().catch(() => ({}))) as { error?: { code?: string } };
	return body.error?.code;
}

async function medianResolutionMs(session: string): Promise<number> {
	const resolve = () =>
		mounted.handler(
			new Request("https://api.example.com/session", {
				method: "GET",
				headers: { Origin: TEST_ORIGIN, ...withSession(session) },
			}),
		);
	for (let round = 0; round < WARM_UP; round += 1) {
		await resolve();
	}
	const durations: number[] = [];
	for (let round = 0; round < MEASURED; round += 1) {
		const started = performance.now();
		const answer = await resolve();
		durations.push(performance.now() - started);
		expect(answer.status).toBe(200);
	}
	durations.sort((left, right) => left - right);
	return durations[Math.floor(durations.length / 2)] ?? Number.NaN;
}

describe("T-INTEG-10: the bound on passkeys and identities (S-INTEG-10)", () => {
	let atTheCap: { userId: string; session: string };

	it("refuses the 21st passkey with passkey_limit_reached", async () => {
		atTheCap = await signUp(`cap-${randomUUID()}@example.com`);
		for (let index = 0; index < DEFAULT_LIMITS.passkeysPerAccount; index += 1) {
			expect((await registerPasskey(atTheCap.session)).status).toBe(200);
		}

		const refused = await registerPasskey(atTheCap.session);

		expect(refused.status).toBe(409);
		expect(await errorCodeOf(refused)).toBe("passkey_limit_reached");
	}, 120_000);

	it("refuses the 11th identity with identity_limit_reached", async () => {
		for (let index = 0; index < DEFAULT_LIMITS.identitiesPerAccount; index += 1) {
			const linked = await linkIdentity(atTheCap.session, `cap-${index}-${randomUUID()}`);
			expect(linked.status, await linked.clone().text()).toBe(302);
			atTheCap = { ...atTheCap, session: sessionOf(linked) };
		}

		const refused = await linkIdentity(atTheCap.session, `cap-over-${randomUUID()}`);
		const [identities] = await mounted.connection.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM ${mounted.schema}.identity WHERE user_id = $1`,
			[atTheCap.userId],
		);

		expect(refused.status).toBe(409);
		expect(await errorCodeOf(refused)).toBe("identity_limit_reached");
		expect(identities?.count).toBe(DEFAULT_LIMITS.identitiesPerAccount);
	}, 120_000);

	it("resolves a session at the cap within three times the cost at one passkey", async () => {
		const small = await signUp(`one-${randomUUID()}@example.com`);
		expect((await registerPasskey(small.session)).status).toBe(200);

		const atOne = await medianResolutionMs(small.session);
		const atCap = await medianResolutionMs(atTheCap.session);

		expect(atCap).toBeLessThanOrEqual(3 * atOne);
	}, 300_000);
});
