import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { VelveAuthConfig } from "../src/core/auth/config.js";
import { VelveStartupError } from "../src/core/auth/startup.js";
import type { Driver } from "../src/core/db/driver.js";
import {
	forgetPluginErrorCodes,
	registerPluginErrorCodes,
	resolveErrorCode,
	toErrorBody,
	VelveError,
} from "../src/core/http/error-map.js";
import { KNOWN_PROVIDERS, type KnownProvider, type OAuthConfig } from "../src/core/oauth/config.js";
import type { VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";

let connection: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("config_seams");
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
};

const GENERIC_PROVIDER_ONLY: OAuthConfig = {
	providers: { mycorp: { clientId: "id", clientSecret: "secret", ...GENERIC_ENDPOINTS } },
	trustedProviders: [],
	storeTokens: true,
};

const BOTH_KINDS: OAuthConfig = {
	providers: {
		github: { clientId: "id", clientSecret: "secret", scopes: ["read:user"] },
		mycorp: { clientId: "id", clientSecret: "secret", ...GENERIC_ENDPOINTS, subjectClaim: "oid" },
	},
	trustedProviders: ["github"],
};

const AUDIT_PLUGIN: VelvePlugin<"audit"> = {
	id: "audit",
	errorCodes: ["audit.rejected"],
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
				start({ oauth: { providers: { [provider]: CREDENTIALS }, trustedProviders: [] } }),
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
		} satisfies OAuthConfig;

		expect(start({ oauth: incomplete })).toThrowError(VelveStartupError);
		expect(start({ oauth: incomplete })).toThrowError(/authorizationEndpoint/);
	});

	it("names the incomplete provider case with its own code", () => {
		const incomplete = {
			providers: { mycorp: { clientId: "id", clientSecret: "secret" } },
			trustedProviders: [],
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

describe("the plugin configuration seam (3.15 G)", () => {
	it("takes a list of plugins and starts", () => {
		expect(start({ plugins: [AUDIT_PLUGIN] })).not.toThrow();
	});

	// The namespace constraint is a type, not a runtime check, so this is the assertion for it.
	it("constrains an error code to the plugin's own namespace", () => {
		expect(AUDIT_PLUGIN.errorCodes).toStrictEqual(["audit.rejected"]);
	});
});

describe("a plugin's own error codes (3.11, §3)", () => {
	afterEach(() => {
		forgetPluginErrorCodes();
	});

	it("resolves a core code from the two tables and a namespaced one from the registry", () => {
		registerPluginErrorCodes({ "audit.rejected": { httpStatus: 409, message: "Refused." } });

		expect(resolveErrorCode("invalid_input")).toStrictEqual({
			httpStatus: 400,
			message: "The request input is not valid.",
		});
		expect(resolveErrorCode("audit.rejected")).toStrictEqual({
			httpStatus: 409,
			message: "Refused.",
		});
	});

	// An unregistered namespaced code must not leak the plugin's own text as a message.
	it("answers an unregistered namespaced code as an internal error", () => {
		const error = new VelveError("audit.never-registered");

		expect(error.httpStatus).toBe(500);
		expect(error.message).toBe("The request could not be completed.");
		expect(toErrorBody(error).error.code).toBe("audit.never-registered");
	});

	it("carries the registered status and message onto VelveError and into the body", () => {
		registerPluginErrorCodes({ "audit.rejected": { httpStatus: 409, message: "Refused." } });
		const error = new VelveError("audit.rejected");

		expect(error.httpStatus).toBe(409);
		expect(toErrorBody(error)).toStrictEqual({
			error: { code: "audit.rejected", message: "Refused." },
		});
	});

	it("refuses a redefinition of a core code and a second answer for its own", () => {
		registerPluginErrorCodes({ "audit.rejected": { httpStatus: 409, message: "Refused." } });

		expect(() =>
			registerPluginErrorCodes({
				invalid_input: { httpStatus: 418, message: "Mine now." },
			} as never),
		).toThrowError(/core error code/);
		expect(() =>
			registerPluginErrorCodes({ "audit.rejected": { httpStatus: 400, message: "Refused." } }),
		).toThrowError(/already registered/);
		expect(() =>
			registerPluginErrorCodes({ "audit.other": { httpStatus: 200, message: "Fine." } }),
		).toThrowError(/4xx or 5xx/);
	});
});
