import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityMode } from "../src/core/db/migrations/identity-mode.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import type { OAuthConfig } from "../src/core/oauth/config.js";
import { createVelveAuth } from "../src/index.js";
import { requestTo, TEST_ORIGIN, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { CALLBACK_BASE_URL, codeCarrying, createStubProvider } from "./oauth-provider.js";

const PROVIDER_ORIGIN = "https://provider.example";
const PROVIDER = "stubby";
const USERNAME_RULES = { minimumLength: 3, maximumLength: 32 };

interface Mounted {
	readonly migrated: MigratedSchema;
	readonly handler: (request: Request) => Promise<Response>;
}

const mounts: Mounted[] = [];
let usernameOnly: Mounted;
let usernameAndEmail: Mounted;

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
	};
}

//each schema carries its own mode's CHECK, which mountAuthInMode does not migrate
async function mountIn(mode: Exclude<IdentityMode, "email">): Promise<Mounted> {
	const provider = await createStubProvider({
		claims: { sub: "provider-subject-without-address", preferred_username: "noaddress" },
	});
	const migrated = await openMigratedSchema(`linkfive_${mode}`, mode);
	const shared = {
		database: migrated.connection,
		schema: migrated.schema,
		keys: testKeyProvider(),
		origins: [TEST_ORIGIN],
		recoveryCodes: { count: 10, groupSize: 5 },
		oauth: configWithoutAnAddress(),
		fetch: provider.fetch,
	};
	const auth =
		mode === "username"
			? createVelveAuth<"username">({ identity: { mode, username: USERNAME_RULES }, ...shared })
			: createVelveAuth<"username_email">({
					identity: { mode, username: USERNAME_RULES },
					email: { send: () => Promise.resolve() },
					...shared,
				});
	const mounted = { migrated, handler: toWebHandler(auth) };
	mounts.push(mounted);
	return mounted;
}

beforeAll(async () => {
	usernameOnly = await mountIn("username");
	usernameAndEmail = await mountIn("username_email");
});

afterAll(async () => {
	for (const { migrated } of mounts) {
		await dropSchema(migrated.connection, migrated.schema);
		await migrated.connection.close();
	}
});

async function signInThroughTheProvider(mounted: Mounted): Promise<Response> {
	const started = await mounted.handler(
		requestTo("/sign-in/oauth/start", { body: { provider: PROVIDER } }),
	);
	const body = (await started.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string };
	};
	const url = new URL(body.authorizationUrl);
	const state = url.searchParams.get("state") ?? "";
	return mounted.handler(
		requestTo(
			`/sign-in/oauth/callback/${PROVIDER}?code=${codeCarrying(url.searchParams.get("nonce"))}&state=${encodeURIComponent(state)}`,
			{ method: "GET", cookie: `__Host-velve_oauth_state=${body.stateCookie.value}` },
		),
	);
}

async function rowsOf(mounted: Mounted, table: string): Promise<string[]> {
	const rows = await mounted.migrated.connection.query<{ rendered: string }>(
		`SELECT t::text AS rendered FROM ${mounted.migrated.schema}.${table} t`,
		[],
	);
	return rows.map((row) => row.rendered);
}

describe("T-LINK-5: a provider without an address creates an account without one (S-LINK-5)", () => {
	it("answers the callback with a redirect and stores one account whose address is NULL", async () => {
		const answer = await signInThroughTheProvider(usernameOnly);
		const users = await usernameOnly.migrated.connection.query<{
			email: string | null;
			username: string | null;
		}>(`SELECT email, username FROM ${usernameOnly.migrated.schema}.user`, []);
		const identities = await usernameOnly.migrated.connection.query<{
			provider_email: string | null;
		}>(`SELECT provider_email FROM ${usernameOnly.migrated.schema}.identity`, []);

		expect(answer.status).toBe(302);
		expect(users).toStrictEqual([{ email: null, username: "noaddress" }]);
		expect(identities).toStrictEqual([{ provider_email: null }]);
	});

	it("holds no address anywhere in the account row, so nothing stood in for one", async () => {
		const users = await rowsOf(usernameOnly, "user");

		expect(users).toHaveLength(1);
		expect(users[0]).not.toContain("@");
	});

	//username_email requires an address on every account and refuses the account rather than inventing one (E-2333)
	it("refuses the account in username_email with 502 and writes no row at all", async () => {
		const answer = await signInThroughTheProvider(usernameAndEmail);

		expect(answer.status).toBe(502);
		expect(await rowsOf(usernameAndEmail, "user")).toStrictEqual([]);
		expect(await rowsOf(usernameAndEmail, "identity")).toStrictEqual([]);
		expect(await rowsOf(usernameAndEmail, "session")).toStrictEqual([]);
	});
});
