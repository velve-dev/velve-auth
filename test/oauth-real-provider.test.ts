import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { OAuthConfig } from "../src/core/oauth/config.js";
import { type MountedAuth, mountAuthInMode, requestTo } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import {
	assertDexIsUp,
	authorizeAtDex,
	DEX_CALLBACK_BASE,
	DEX_CLIENT_ID,
	DEX_CLIENT_SECRET,
	DEX_ISSUER,
	fetchReachingDex,
} from "./dex-provider.js";

const PROVIDER = "dex";
const mounted: MountedAuth<"username_email">[] = [];

beforeAll(assertDexIsUp);

afterEach(async () => {
	for (const instance of mounted.splice(0)) {
		await dropSchema(instance.connection, instance.schema);
		await instance.connection.close();
	}
});

function configWith(contribute: OAuthConfig["identifiersForNewAccount"]): OAuthConfig {
	return {
		providers: {
			[PROVIDER]: {
				clientId: DEX_CLIENT_ID,
				clientSecret: DEX_CLIENT_SECRET,
				authorizationEndpoint: `${DEX_ISSUER}/auth`,
				tokenEndpoint: `${DEX_ISSUER}/token`,
				userInfoEndpoint: `${DEX_ISSUER}/userinfo`,
				jwksUri: `${DEX_ISSUER}/keys`,
				issuer: DEX_ISSUER,
				scopes: ["openid", "email", "profile"],
				subjectClaim: "sub",
				emailClaim: "email",
				emailVerifiedClaim: "email_verified",
			},
		},
		callbackBaseUrl: DEX_CALLBACK_BASE,
		trustedProviders: [PROVIDER],
		...(contribute === undefined ? {} : { identifiersForNewAccount: contribute }),
	} as unknown as OAuthConfig;
}

async function mountWith(
	contribute: OAuthConfig["identifiersForNewAccount"],
): Promise<MountedAuth<"username_email">> {
	const auth = await mountAuthInMode<"username_email">(
		"oauthreal",
		{ mode: "username_email", username: { minimumLength: 3, maximumLength: 32 } },
		{ oauth: configWith(contribute), fetch: fetchReachingDex },
	);
	mounted.push(auth);
	return auth;
}

/** The whole flow, driven end to end: our start route, Dex's own login, our callback route. */
async function signInThroughDex(auth: MountedAuth<"username_email">): Promise<Response> {
	const started = await auth.handler(
		requestTo("/sign-in/oauth/start", { body: { provider: PROVIDER } }),
	);
	const body = (await started.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string };
	};
	const returned = await authorizeAtDex(body.authorizationUrl);
	return auth.handler(
		requestTo(`/sign-in/oauth/callback/${PROVIDER}${returned.search}`, {
			method: "GET",
			cookie: `__Host-velve_oauth_state=${body.stateCookie.value}`,
		}),
	);
}

async function accountRow(
	auth: MountedAuth<"username_email">,
): Promise<{ email: string | null; username: string | null } | undefined> {
	const rows = await auth.connection.query<{ email: string | null; username: string | null }>(
		`SELECT email, username FROM ${auth.schema}.user LIMIT 1`,
		[],
	);
	return rows[0];
}

/**
 * The acceptance the report asks for: somebody who did not exist signs in through a **real**
 * provider and afterwards has an account, with a username that came from the application rather
 * than from a guess of the library's. Dex signs its own id token and serves its own JWKS, so the
 * code exchange, the PKCE verifier and the signature verification are all exercised against an
 * implementation this repository did not write.
 */
describe("a person who did not exist signs in through a real provider (E-1903)", () => {
	it("creates the account, with the username the application supplied", async () => {
		// Dex puts the name in `name`; another provider uses `preferred_username` and a third has
		// none at all. That the application picks is the whole argument for a callback over a
		// claim named in configuration (E-1901).
		const auth = await mountWith(({ account }) => ({
			username: String(account.claims.name ?? "").replaceAll(/[^a-z0-9]/gi, ""),
		}));

		const answer = await signInThroughDex(auth);

		expect(answer.status).toBeLessThan(400);
		expect(await accountRow(auth)).toStrictEqual({
			email: "newcomer@example.com",
			username: "newcomer",
		});
	});

	/** The counter-case, against the same real provider: supply nothing and nothing is created. */
	it("creates nothing when the application supplies no username", async () => {
		const auth = await mountWith(undefined);

		const answer = await signInThroughDex(auth);

		expect(answer.status).toBeGreaterThanOrEqual(400);
		expect(await answer.clone().text()).toContain("oauth_flow_invalid");
		expect(await accountRow(auth)).toBeUndefined();
	});
});
