import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toWebHandler } from "../src/core/http/web-handler.js";
import type { OAuthConfig } from "../src/core/oauth/config.js";
import { createVelveAuth } from "../src/index.js";
import { requestTo, TEST_ORIGIN, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { CALLBACK_BASE_URL, codeCarrying, createStubProvider } from "./oauth-provider.js";

const PROVIDER_ORIGIN = "https://provider.example";
const PROVIDER = "stubby";

let migrated: MigratedSchema;
let handler: (request: Request) => Promise<Response>;

//the provider declares no address claim and reports none, which is the case S-LINK-5 is about
function configWithoutAnAddress(): OAuthConfig {
	return {
		providers: {
			[PROVIDER]: {
				clientId: "velve-test-client",
				clientSecret: "client-secret",
				authorizationEndpoint: `${PROVIDER_ORIGIN}/authorize`,
				tokenEndpoint: `${PROVIDER_ORIGIN}/token`,
				userInfoEndpoint: `${PROVIDER_ORIGIN}/userinfo`,
				subjectClaim: "sub",
			},
		},
		callbackBaseUrl: CALLBACK_BASE_URL,
		trustedProviders: [PROVIDER],
		identifiersForNewAccount: ({ account }) => ({
			username: String(account.claims.preferred_username),
		}),
	} as unknown as OAuthConfig;
}

//the schema carries the username CHECK, which mountAuthInMode does not migrate
beforeAll(async () => {
	const provider = await createStubProvider({
		claims: { sub: "provider-subject-without-address", preferred_username: "noaddress" },
	});
	migrated = await openMigratedSchema("linkfive", "username");
	handler = toWebHandler(
		createVelveAuth<"username">({
			identity: { mode: "username", username: { minimumLength: 3, maximumLength: 32 } },
			database: migrated.connection,
			schema: migrated.schema,
			keys: testKeyProvider(),
			origins: [TEST_ORIGIN],
			recoveryCodes: { count: 10, groupSize: 5 },
			oauth: configWithoutAnAddress(),
			fetch: provider.fetch,
		}),
	);
});

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

async function signInThroughTheProvider(): Promise<Response> {
	const started = await handler(
		requestTo("/sign-in/oauth/start", { body: { provider: PROVIDER } }),
	);
	const body = (await started.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string };
	};
	const url = new URL(body.authorizationUrl);
	const state = url.searchParams.get("state") ?? "";
	return handler(
		requestTo(
			`/sign-in/oauth/callback/${PROVIDER}?code=${codeCarrying(url.searchParams.get("nonce"))}&state=${encodeURIComponent(state)}`,
			{ method: "GET", cookie: `__Host-velve_oauth_state=${body.stateCookie.value}` },
		),
	);
}

/**
 * The mode `username_email` is the second configuration S-LINK-5 names, and it is not exercised
 * here: its CHECK constraint requires an address on every account, so an account without one
 * cannot exist in it. That contradiction is recorded in the decision log rather than tested.
 */
describe("T-LINK-5: a provider without an address creates an account without one (S-LINK-5)", () => {
	it("answers the callback with a redirect and stores one account whose address is NULL", async () => {
		const answer = await signInThroughTheProvider();
		const users = await migrated.connection.query<{
			email: string | null;
			username: string | null;
		}>(`SELECT email, username FROM ${migrated.schema}.user`, []);
		const identities = await migrated.connection.query<{ provider_email: string | null }>(
			`SELECT provider_email FROM ${migrated.schema}.identity`,
			[],
		);

		expect(answer.status).toBe(302);
		expect(users).toStrictEqual([{ email: null, username: "noaddress" }]);
		expect(identities).toStrictEqual([{ provider_email: null }]);
	});

	it("holds no address anywhere in the account row, so nothing stood in for one", async () => {
		const [row] = await migrated.connection.query<{ rendered: string }>(
			`SELECT u::text AS rendered FROM ${migrated.schema}.user u`,
			[],
		);

		expect(row?.rendered).toBeDefined();
		expect(row?.rendered).not.toContain("@");
	});
});
