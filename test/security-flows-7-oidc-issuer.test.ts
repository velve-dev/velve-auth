import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { VelveStartupError } from "../src/core/auth/startup.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import type { GenericProviderConfig, OAuthConfig } from "../src/core/oauth/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { CALLBACK_BASE_URL, codeCarrying, createStubProvider } from "./oauth-provider.js";

/**
 * FLOWS-7, risk 5: the issuer of an ID token is verified (OIDC Core 3.1.3.7 step 2). A provider
 * with a JWKS and no issuer to compare its `iss` with had the token's issuer checked against
 * nothing when the callback carried no `iss` parameter. A generic provider in that shape is
 * refused at start, and the built-in `microsoft` compares `iss` with the issuer its own `tid`
 * claim names, as Microsoft documents the validation of a multi-tenant token.
 */

const PROVIDER_ORIGIN = "https://provider.example";
const PROVIDER_JWKS = `${PROVIDER_ORIGIN}/jwks`;
const CLIENT_ID = "velve-test-client";
const TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
const TENANT_ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;

const mounted: MountedAuth[] = [];

afterEach(async () => {
	for (const instance of mounted.splice(0)) {
		await dropSchema(instance.connection, instance.schema);
		await instance.connection.close();
	}
});

//the built-in microsoft pointed at the stub, which is the shape whose issuer names the tenant
function microsoftAtTheStub(): OAuthConfig {
	return {
		providers: {
			microsoft: {
				clientId: CLIENT_ID,
				clientSecret: "client-secret",
				authorizationEndpoint: `${PROVIDER_ORIGIN}/authorize`,
				tokenEndpoint: `${PROVIDER_ORIGIN}/token`,
				userInfoEndpoint: `${PROVIDER_ORIGIN}/userinfo`,
				jwksUri: PROVIDER_JWKS,
			},
		},
		callbackBaseUrl: CALLBACK_BASE_URL,
		trustedProviders: [],
	};
}

interface IssuedToken {
	readonly iss: string;
	readonly tid?: string;
	readonly sub: string;
}

//signs in through microsoft with an ID token the test writes, under a key the provider publishes
async function signInWithAnIdTokenOf(token: IssuedToken): Promise<Response> {
	const provider = await createStubProvider({ claims: { sub: "unused" }, openIdConnect: true });
	const signing = await generateKeyPair("RS256", { extractable: true });
	const publicJwk = { ...(await exportJWK(signing.publicKey)), kid: "other", alg: "RS256" };
	const fetchWithASharedKeySet: typeof globalThis.fetch = (input, init) =>
		String(input).startsWith(PROVIDER_JWKS)
			? Promise.resolve(
					new Response(JSON.stringify({ keys: [publicJwk] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				)
			: provider.fetch(input, init);
	const mount = await mountAuth("secflowsissuer", {
		oauth: microsoftAtTheStub(),
		fetch: fetchWithASharedKeySet,
	});
	mounted.push(mount);

	const started = await mount.handler(
		requestTo("/sign-in/oauth/start", { body: { provider: "microsoft" } }),
	);
	const body = (await started.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string };
	};
	const url = new URL(body.authorizationUrl);
	const nonce = url.searchParams.get("nonce") ?? "";
	provider.replaceIdToken(
		await new SignJWT({
			sub: token.sub,
			email: `${token.sub}@tenant.example`,
			nonce,
			...(token.tid === undefined ? {} : { tid: token.tid }),
		})
			.setProtectedHeader({ alg: "RS256", kid: "other" })
			.setIssuer(token.iss)
			.setAudience(CLIENT_ID)
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(signing.privateKey),
	);
	const state = url.searchParams.get("state") ?? "";
	return mount.handler(
		requestTo(
			`/sign-in/oauth/callback/microsoft?code=${codeCarrying(nonce)}&state=${encodeURIComponent(state)}`,
			{ method: "GET", cookie: `__Host-velve_oauth_state=${body.stateCookie.value}` },
		),
	);
}

function sessionCookieOf(answer: Response): string | undefined {
	return answer.headers
		.getSetCookie()
		.find(
			(header) =>
				header.startsWith(`${DEFAULT_COOKIE_NAMES.session}=`) &&
				!header.startsWith(`${DEFAULT_COOKIE_NAMES.session}=;`),
		);
}

describe("FLOWS-7: an ID token from another issuer is refused", () => {
	it("refuses an ID token whose iss names an issuer the provider is not", async () => {
		const answer = await signInWithAnIdTokenOf({
			iss: "https://another-issuer.example",
			tid: TENANT,
			sub: "someone-at-another-issuer",
		});

		expect(answer.status).toBe(400);
		expect(await answer.json()).toMatchObject({ error: { code: "oauth_flow_invalid" } });
		expect(sessionCookieOf(answer)).toBeUndefined();
	});

	it("refuses a microsoft ID token whose iss names another tenant than its tid", async () => {
		const answer = await signInWithAnIdTokenOf({
			iss: "https://login.microsoftonline.com/another-tenant/v2.0",
			tid: TENANT,
			sub: "someone-of-another-tenant",
		});

		expect(answer.status).toBe(400);
		expect(sessionCookieOf(answer)).toBeUndefined();
	});

	it("refuses a microsoft ID token that carries no tid", async () => {
		const answer = await signInWithAnIdTokenOf({ iss: TENANT_ISSUER, sub: "someone-without-tid" });

		expect(answer.status).toBe(400);
		expect(sessionCookieOf(answer)).toBeUndefined();
	});

	it("accepts a microsoft ID token whose iss is the issuer its tid names", async () => {
		const answer = await signInWithAnIdTokenOf({
			iss: TENANT_ISSUER,
			tid: TENANT,
			sub: "someone-of-the-tenant",
		});

		expect(answer.status).toBe(302);
		expect(sessionCookieOf(answer)).toBeDefined();
	});
});

const GENERIC_WITH_A_KEY_SET: GenericProviderConfig = {
	clientId: CLIENT_ID,
	clientSecret: "client-secret",
	authorizationEndpoint: `${PROVIDER_ORIGIN}/authorize`,
	tokenEndpoint: `${PROVIDER_ORIGIN}/token`,
	jwksUri: PROVIDER_JWKS,
	subjectClaim: "sub",
};

async function startupRefusalOf(provider: GenericProviderConfig): Promise<unknown> {
	const { connection, schema } = await openMigratedSchema("secflowsissuerstart");
	try {
		createVelveAuth(
			configFor({
				database: connection,
				schema,
				oauth: {
					providers: { mycorp: provider },
					callbackBaseUrl: CALLBACK_BASE_URL,
					trustedProviders: [],
				},
			}),
		);
		return null;
	} catch (refusal) {
		return refusal;
	} finally {
		await dropSchema(connection, schema);
		await connection.close();
	}
}

describe("FLOWS-7: a provider with a JWKS and no issuer does not start", () => {
	it("refuses a generic provider that names a jwksUri and no issuer", async () => {
		const refusal = await startupRefusalOf(GENERIC_WITH_A_KEY_SET);

		expect(refusal).toBeInstanceOf(VelveStartupError);
		expect((refusal as VelveStartupError).code).toBe("oauth_provider_issuer_missing");
	});

	it("starts the same provider once it names its issuer", async () => {
		expect(
			await startupRefusalOf({ ...GENERIC_WITH_A_KEY_SET, issuer: PROVIDER_ORIGIN }),
		).toBeNull();
	});
});
