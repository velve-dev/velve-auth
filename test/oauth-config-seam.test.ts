import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { VelveAuthConfig } from "../src/core/auth/config.js";
import { VelveStartupError } from "../src/core/auth/startup.js";
import type { Driver } from "../src/core/db/driver.js";
import { KNOWN_PROVIDERS, type KnownProvider, type OAuthConfig } from "../src/core/oauth/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";

let connection: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("oauth_config_seam");
	connection = migrated.connection;
	schema = migrated.schema;
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

function start(overrides: Partial<VelveAuthConfig<"email">>): () => unknown {
	return () => createVelveAuth(configFor({ database: connection as Driver, schema, ...overrides }));
}

const CREDENTIALS = { clientId: "id", clientSecret: "secret" };

/** The callback route's own URL: every provider's `redirect_uri` is this with the id appended (E-540). */
const CALLBACK_BASE_URL = "https://api.example.com/sign-in/oauth/callback";

const GENERIC_ENDPOINTS = {
	authorizationEndpoint: "https://issuer.example/authorize",
	tokenEndpoint: "https://issuer.example/token",
	subjectClaim: "sub",
};

/**
 * These values are the assertion: the primary case of 3.15 A.8 is a named provider configured with
 * credentials alone, and the type this cut shipped first could not express it (E-718). A test that
 * only ran the start-up check would have passed over that, because it never fails to compile.
 */
const NAMED_PROVIDER_ONLY: OAuthConfig = {
	providers: { google: { clientId: "id", clientSecret: "secret" } },
	trustedProviders: ["google"],
	callbackBaseUrl: CALLBACK_BASE_URL,
};

const GENERIC_PROVIDER_ONLY: OAuthConfig = {
	providers: { mycorp: { clientId: "id", clientSecret: "secret", ...GENERIC_ENDPOINTS } },
	trustedProviders: [],
	storeTokens: true,
	callbackBaseUrl: CALLBACK_BASE_URL,
};

const BOTH_KINDS: OAuthConfig = {
	providers: {
		github: { clientId: "id", clientSecret: "secret", scopes: ["read:user"] },
		mycorp: { clientId: "id", clientSecret: "secret", ...GENERIC_ENDPOINTS, subjectClaim: "oid" },
	},
	trustedProviders: ["github"],
	callbackBaseUrl: CALLBACK_BASE_URL,
};

/**
 * The array and the union are two statements of the same fourteen names, and the array is what
 * decides at start whether an id needs its own endpoints. A name in the union and not in the array
 * typechecks as configuration and then cannot start, which no other assertion here would see: the
 * `Record` makes the compiler require every member, and the comparison makes the array match it.
 */
const EVERY_KNOWN_PROVIDER: Readonly<Record<KnownProvider, true>> = {
	google: true,
	github: true,
	apple: true,
	microsoft: true,
	gitlab: true,
	discord: true,
	facebook: true,
	linkedin: true,
	twitch: true,
	spotify: true,
	slack: true,
	notion: true,
	zoom: true,
	dropbox: true,
};

describe("the fourteen providers of 3.10 are one list, written twice", () => {
	it("holds the same names in the array as in the union", () => {
		expect([...KNOWN_PROVIDERS].sort()).toStrictEqual(Object.keys(EVERY_KNOWN_PROVIDER).sort());
	});

	it("starts for every one of them configured with credentials alone", () => {
		for (const provider of KNOWN_PROVIDERS) {
			expect(
				start({
					oauth: {
						providers: { [provider]: CREDENTIALS },
						trustedProviders: [],
						callbackBaseUrl: CALLBACK_BASE_URL,
					},
				}),
				provider,
			).not.toThrow();
		}
	});
});

describe("the oauth configuration seam (3.15 A.8)", () => {
	it("takes a named provider with credentials and nothing else", () => {
		expect(start({ oauth: NAMED_PROVIDER_ONLY })).not.toThrow();
	});

	it("takes a generic provider and a mixture of both kinds", () => {
		expect(start({ oauth: GENERIC_PROVIDER_ONLY })).not.toThrow();
		expect(start({ oauth: BOTH_KINDS })).not.toThrow();
	});

	// The index signature admits credentials alone for every id, so the shape an unknown id must
	// carry is decided at start rather than by the type (E-718).
	it("refuses an unknown provider id that carries no endpoints", () => {
		const incomplete = {
			providers: { mycorp: { clientId: "id", clientSecret: "secret" } },
			trustedProviders: [],
			callbackBaseUrl: CALLBACK_BASE_URL,
		} satisfies OAuthConfig;

		expect(start({ oauth: incomplete })).toThrowError(VelveStartupError);
		expect(start({ oauth: incomplete })).toThrowError(/authorizationEndpoint/);
	});

	it("names the incomplete provider case with its own code", () => {
		const incomplete = {
			providers: { mycorp: { clientId: "id", clientSecret: "secret" } },
			trustedProviders: [],
			callbackBaseUrl: CALLBACK_BASE_URL,
		} satisfies OAuthConfig;

		try {
			start({ oauth: incomplete })();
			expect.unreachable("an unknown provider without endpoints started");
		} catch (error) {
			expect(error).toBeInstanceOf(VelveStartupError);
			expect((error as VelveStartupError).code).toBe("oauth_provider_incomplete");
		}
	});
});
