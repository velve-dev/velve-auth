import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import type { VelveAuthConfig, WebAuthnConfig } from "../src/core/auth/config.js";
import { rateLimitConfigOf } from "../src/core/auth/rate-limiting.js";
import { SECURITY_OPTIONS } from "../src/core/auth/security-options.js";
import { VelveStartupError } from "../src/core/auth/startup.js";
import {
	TRUST_LEVEL_EVENT_REVOKES_OTHER_SESSIONS,
	TRUST_LEVEL_EVENTS,
} from "../src/core/auth/trust-level.js";
import type { Driver } from "../src/core/db/driver.js";
import { DEFAULT_RECOVERY_CODE_SHAPE } from "../src/core/factor/recovery/code.js";
import { TOTP_TOLERANCE_STEPS } from "../src/core/factor/totp/parameters.js";
import { encodeBase64Url } from "../src/core/keys/base64url.js";
import { KeyError, rootKeyProvider } from "../src/core/keys/index.js";
import { resolvePasswordConfig } from "../src/core/password/config.js";
import { DEFAULT_SESSION_CONFIG, sessionSettingsOf } from "../src/core/session/config.js";
import { DEFAULT_SESSION_METADATA_MODE } from "../src/core/session/metadata.js";
import { createVelveAuth } from "../src/index.js";
import { createTestClock } from "../src/testing/index.js";
import { configFor, createLogSink, TEST_ORIGIN, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";

let connection: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("startup");
	connection = migrated.connection;
	schema = migrated.schema;
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

function start(overrides: Partial<VelveAuthConfig<"email">> = {}): () => unknown {
	return () => createVelveAuth(configFor({ database: connection as Driver, schema, ...overrides }));
}

describe("the root key is a condition of starting at all (S-KEY-6, T-KEY-6)", () => {
	// T-KEY-6: lengths 0, 8 and 31 bytes, a missing `keys` field, and 32 bytes — four refuse, one starts.
	it("refuses four of five attempts and starts on the fifth", () => {
		const outcomes = [0, 8, 31, 32].map((length) => {
			try {
				const keys = rootKeyProvider({
					currentVersion: 1,
					keysByVersion: { 1: encodeBase64Url(randomBytes(length)) },
				});
				start({ keys })();
				return "started";
			} catch (cause) {
				return cause instanceof KeyError || cause instanceof VelveStartupError
					? "refused"
					: "refused for another reason";
			}
		});

		const withoutKeys = (() => {
			try {
				start({ keys: undefined as never })();
				return "started";
			} catch (cause) {
				return cause instanceof VelveStartupError ? "refused" : "refused for another reason";
			}
		})();

		expect([...outcomes, withoutKeys]).toStrictEqual([
			"refused",
			"refused",
			"refused",
			"started",
			"refused",
		]);
	});
});

describe("what else refuses to start", () => {
	it("refuses an empty origin list rather than reading it as a blanket permission", () => {
		expect(start({ origins: [] })).toThrow(VelveStartupError);
		expect(start({ origins: ["https://app.example.com"] })).not.toThrow();
	});

	// A.2: without a send callback there is no way to verify an address or to reset a password.
	it("refuses an address mode without a send callback", () => {
		expect(start({ email: undefined as never })).toThrow(VelveStartupError);
	});

	/**
	 * S-DEFAULT-4, E-207. Both halves are asserted, and the compile-time one only because the cast
	 * is gone: this read `createVelveAuth(withoutCodes as never)` for the failing case, and `as
	 * never` is assignable to anything, so the assertion said the same thing whether the type
	 * worked or not. §3 asks for `@ts-expect-error` beside a failing-by-design case; without it the
	 * type half was unobserved for as long as it was broken (E-350).
	 */
	it("refuses the username mode without recovery codes and starts with them", () => {
		const usernameMode = {
			database: connection as Driver,
			schema,
			identity: { mode: "username" as const },
			keys: testKeyProvider(),
			origins: [TEST_ORIGIN],
		};

		expect(() =>
			// @ts-expect-error RecoveryCodesRequirement makes the omission a compile error first.
			createVelveAuth(usernameMode),
		).toThrow(VelveStartupError);
		expect(() =>
			createVelveAuth({ ...usernameMode, recoveryCodes: { count: 10, groupSize: 5 } }),
		).not.toThrow();
	});

	/**
	 * 3.15 A.1 chose design B so that the error names the mode. It named the union instead, for the
	 * same reason S-DEFAULT-4 did not bite: the mode was not inferrable, so every instance was
	 * `VelveAuth<IdentityMode>` and the namespace was pruned in the one mode that has it.
	 */
	it("carries the username namespace where the mode has usernames, and not where it does not", () => {
		const withUsernames = createVelveAuth({
			database: connection as Driver,
			schema,
			identity: { mode: "username" as const },
			keys: testKeyProvider(),
			origins: [TEST_ORIGIN],
			recoveryCodes: { count: 10, groupSize: 5 },
		});
		const addressesOnly = createVelveAuth(configFor({ database: connection as Driver, schema }));

		expectTypeOf(withUsernames.username.isAvailable).toBeFunction();
		expect(typeof withUsernames.username.isAvailable).toBe("function");
		// @ts-expect-error the mode has no usernames, and the message says so rather than "never".
		expect(addressesOnly.username).toBeUndefined();
	});

	/**
	 * A.8 types both fields `number`, and E-1696 recorded the two values that type admits which
	 * cannot be honoured falling back to the default in silence. `count: 0` in the mode that makes
	 * the field mandatory is the lockout S-DEFAULT-4 refuses, reintroduced through the field.
	 */
	it.each([
		["count", 0],
		["count", -1],
		["count", 1.5],
		["groupSize", 0],
		["groupSize", -4],
		["groupSize", Number.NaN],
	] as const)("refuses recoveryCodes.%s of %s rather than narrowing it", (field, configured) => {
		expect(start({ recoveryCodes: { count: 10, groupSize: 5, [field]: configured } })).toThrow(
			VelveStartupError,
		);
	});

	it("names the unusable shape in a machine-readable code", () => {
		try {
			start({ recoveryCodes: { count: 0, groupSize: 5 } })();
			throw new Error("the configuration was accepted");
		} catch (failure) {
			expect(failure).toBeInstanceOf(VelveStartupError);
			expect((failure as VelveStartupError).code).toBe("recovery_code_shape_unusable");
		}
	});

	it("starts on the shape A.8 declares and on an operator's own whole numbers", () => {
		expect(start({ recoveryCodes: { count: 10, groupSize: 5 } })).not.toThrow();
		expect(start({ recoveryCodes: { count: 16, groupSize: 8 } })).not.toThrow();
		expect(start()).not.toThrow();
	});

	// S-DEFAULT-6: the floor is a floor; the refusal is the password module's and is reached here.
	it("refuses argon2id parameters below the floor", () => {
		expect(
			start({ password: { argon2id: { memoryKiB: 1024, iterations: 2, parallelism: 1 } } }),
		).toThrow();
		expect(
			start({ password: { argon2id: { memoryKiB: 65536, iterations: 3, parallelism: 1 } } }),
		).not.toThrow();
	});
});

describe("the weakenings an operator is told about (S-DEFAULT-1, T-DEFAULT-1)", () => {
	it("says nothing at all about an option left at its default", () => {
		const log = createLogSink();
		start({ log: log.write })();

		const weakened = log.lines.filter(
			(line) => line.message === "a security option is weaker than its default",
		);

		expect(weakened.map((line) => line.fields.option)).toStrictEqual([]);
	});

	it("writes exactly one line per weakened option, naming the option", () => {
		const log = createLogSink();
		start({
			log: log.write,
			sessionMetadata: "full",
			trustedProxies: ["10.0.0.0/8"],
			clock: createTestClock(),
			session: { freshnessWindow: "1h" },
		})();

		const weakened = log.lines.filter(
			(line) => line.message === "a security option is weaker than its default",
		);

		expect(weakened.map((line) => line.fields.option).sort()).toStrictEqual([
			"clock",
			"session",
			"sessionMetadata",
			"trustedProxies",
		]);
		expect(new Set(weakened.map((line) => line.fields.option)).size).toBe(weakened.length);
	});

	/**
	 * E-1694 found the `totp` detector reading a value typed `0 | 1` and testing `> 1`, so it could
	 * fire for no value the type admits, and for an untyped caller it reported a weakening the
	 * library had already refused to apply. Both halves are asserted here.
	 */
	it.each([0, 1, 2, 10] as const)(
		"says nothing about a step tolerance of %s, because none of them widens the window",
		(stepToleranceInSteps) => {
			const log = createLogSink();
			start({
				log: log.write,
				totp: { stepToleranceInSteps: stepToleranceInSteps as 0 | 1 },
			})();

			const weakened = log.lines.filter(
				(line) => line.message === "a security option is weaker than its default",
			);

			expect(weakened.map((line) => line.fields.option)).toStrictEqual([]);
		},
	);

	it("declares of totp that nothing weakens it, because the row is what an operator reads", () => {
		const totp = SECURITY_OPTIONS.find((option) => option.option === "totp");

		expect(totp?.weakenedBy).toContain("not applied");
	});

	/** T-DEFAULT-1: a key of the option type that nobody classified fails here, not in an advisory. */
	it("classifies every key of the option type", () => {
		const declared = new Set(SECURITY_OPTIONS.map((option) => option.option));
		const written = optionKeysWrittenInTheConfigurationType();

		expect(written.length).toBeGreaterThanOrEqual(15);
		expect(written.filter((key) => !declared.has(key as never))).toStrictEqual([]);
		expect(SECURITY_OPTIONS.length).toBe(declared.size);
	});
});

const WEAKENED_LINE = "a security option is weaker than its default";

function weakenedOptionsLoggedAt(overrides: Partial<VelveAuthConfig<"email">>): readonly unknown[] {
	const log = createLogSink();
	start({ log: log.write, ...overrides })();
	return log.lines
		.filter((line) => line.message === WEAKENED_LINE)
		.map((line) => line.fields.option);
}

/**
 * One documented weakening per case, and each case is what the row's `weakenedBy` names. The
 * refill and timeout cases are the ones an audit found logging nothing: a bucket refilling a
 * billion tokens a second limits nothing, and a session that lives a year is not the default.
 */
const DOCUMENTED_WEAKENINGS: readonly (readonly [
	string,
	string,
	Partial<VelveAuthConfig<"email">>,
])[] = [
	["session", "a freshness window of one hour", { session: { freshnessWindow: "1h" } }],
	["session", "an idle timeout of fourteen days", { session: { idleTimeout: "14d" } }],
	["session", "an absolute timeout of a year", { session: { absoluteTimeout: "365d" } }],
	[
		"session",
		"an idle and an absolute timeout of a year together",
		{ session: { idleTimeout: "365d", absoluteTimeout: "365d" } },
	],
	["sessionMetadata", 'the mode "full"', { sessionMetadata: "full" }],
	["trustedProxies", "one trusted range", { trustedProxies: ["10.0.0.0/8"] }],
	[
		"rateLimit",
		"an address capacity of thirty-one",
		{ rateLimit: { perIpAddress: { capacity: 31, refillPerSecond: 0.5 } } },
	],
	[
		"rateLimit",
		"an address refill of a billion a second",
		{ rateLimit: { perIpAddress: { capacity: 30, refillPerSecond: 1e9 } } },
	],
	[
		"rateLimit",
		"an account refill of twice the default",
		{ rateLimit: { perAccount: { capacity: 5, refillPerSecond: 2 / 300 } } },
	],
	[
		"oauth",
		"a trusted provider",
		{
			oauth: {
				providers: { github: { clientId: "client", clientSecret: "secret" } },
				callbackBaseUrl: `${TEST_ORIGIN}/api/auth/sign-in/oauth/callback`,
				trustedProviders: ["github"],
			},
		},
	],
	[
		"oauth",
		"stored provider tokens",
		{
			oauth: {
				providers: { github: { clientId: "client", clientSecret: "secret" } },
				callbackBaseUrl: `${TEST_ORIGIN}/api/auth/sign-in/oauth/callback`,
				trustedProviders: [],
				storeTokens: true,
			},
		},
	],
	[
		"fetch",
		"a fetch the caller supplied",
		{ fetch: (input, init) => globalThis.fetch(input, init) },
	],
	["plugins", "one plugin", { plugins: [{ id: "audit" }] }],
	[
		"webauthn",
		'"preferred" user verification',
		{
			webauthn: {
				relyingPartyId: "app.example.com",
				relyingPartyName: "Example",
				origins: [TEST_ORIGIN],
				userVerification: "preferred",
			},
		},
	],
	["recoveryCodes", "nine codes", { recoveryCodes: { count: 9, groupSize: 5 } }],
	["clock", "a settable clock", { clock: createTestClock() }],
	["securityState", 'sealing "migrating"', { securityState: { sealing: "migrating" } }],
	["limits", "forty passkeys", { limits: { passkeysPerAccount: 40 } }],
];

describe("every documented weakening is logged once at start (S-DEFAULT-1, T-DEFAULT-1)", () => {
	it.each(DOCUMENTED_WEAKENINGS)(
		"names %s for %s, in exactly one line",
		(option, _label, overrides) => {
			expect(weakenedOptionsLoggedAt(overrides)).toStrictEqual([option]);
		},
	);

	it("has a case for every row a caller can weaken, and no case for a row nothing weakens", () => {
		const weakenable = SECURITY_OPTIONS.filter((row) => !row.weakenedBy.startsWith("nothing"))
			.map((row) => row.option)
			.sort();
		const covered = [...new Set(DOCUMENTED_WEAKENINGS.map(([option]) => option))].sort();

		expect(weakenable.length).toBeGreaterThanOrEqual(10);
		expect(covered).toStrictEqual(weakenable);
	});

	it("says nothing about a value written out at exactly its default", () => {
		const rates = rateLimitConfigOf();

		expect(
			weakenedOptionsLoggedAt({
				session: DEFAULT_SESSION_CONFIG,
				sessionMetadata: DEFAULT_SESSION_METADATA_MODE,
				trustedProxies: [],
				rateLimit: { perIpAddress: rates.perIpAddress, perAccount: rates.perAccount },
				recoveryCodes: DEFAULT_RECOVERY_CODE_SHAPE,
				plugins: [],
				securityState: { sealing: "required" },
			}),
		).toStrictEqual([]);
	});

	it("says nothing about a relying party that leaves user verification at its default", () => {
		const relyingParty = {
			relyingPartyId: "app.example.com",
			relyingPartyName: "Example",
			origins: [TEST_ORIGIN],
		};

		expect(
			weakenedOptionsLoggedAt({
				webauthn: relyingParty as unknown as WebAuthnConfig,
			}),
		).toStrictEqual([]);
		expect(
			weakenedOptionsLoggedAt({ webauthn: { ...relyingParty, userVerification: "required" } }),
		).toStrictEqual([]);
	});

	it("says nothing about a value stricter than its default", () => {
		expect(
			weakenedOptionsLoggedAt({
				session: { idleTimeout: "1d", absoluteTimeout: "2d", freshnessWindow: "5m" },
				rateLimit: {
					perIpAddress: { capacity: 3, refillPerSecond: 0.05 },
					perAccount: { capacity: 2, refillPerSecond: 0.001 },
				},
				recoveryCodes: { count: 16, groupSize: 8 },
			}),
		).toStrictEqual([]);
	});
});

/** A.2, A.4, A.5, A.6 and A.8 of the architecture, written down once as the fixture T-DEFAULT-1 asks for. */
const SPECIFIED_DEFAULTS = {
	session: {
		idleTimeout: "7d",
		absoluteTimeout: "30d",
		idleWriteInterval: "1h",
		freshnessWindow: "15m",
		cookieName: "__Host-velve_session",
		cookie: { sameSite: "lax" },
	},
	perIpAddress: { capacity: 30, refillPerSecond: 0.5 },
	perAccount: { capacity: 5, refillPerSecond: 1 / 300 },
	argon2id: { memoryKiB: 19456, iterations: 2, parallelism: 1 },
	sessionMetadata: "truncated",
	recoveryCodes: { count: 10, groupSize: 5 },
	totpToleranceInSteps: 1,
} as const;

function safeDefaultOf(option: string): string | undefined {
	return SECURITY_OPTIONS.find((row) => row.option === option)?.safeDefault;
}

describe("the defaults the rows state are the defaults the code uses (S-DEFAULT-1, T-DEFAULT-1)", () => {
	it("uses exactly the specified defaults", () => {
		const rates = rateLimitConfigOf();

		expect(DEFAULT_SESSION_CONFIG).toStrictEqual(SPECIFIED_DEFAULTS.session);
		expect(rates.perIpAddress).toStrictEqual(SPECIFIED_DEFAULTS.perIpAddress);
		expect(rates.perAccount).toStrictEqual(SPECIFIED_DEFAULTS.perAccount);
		expect(resolvePasswordConfig().argon2id).toStrictEqual(SPECIFIED_DEFAULTS.argon2id);
		expect(DEFAULT_SESSION_METADATA_MODE).toBe(SPECIFIED_DEFAULTS.sessionMetadata);
		expect(DEFAULT_RECOVERY_CODE_SHAPE).toStrictEqual(SPECIFIED_DEFAULTS.recoveryCodes);
		expect(TOTP_TOLERANCE_STEPS).toBe(SPECIFIED_DEFAULTS.totpToleranceInSteps);
	});

	it("states in each row the default the code uses", () => {
		const { session, perIpAddress, perAccount, argon2id, recoveryCodes } = SPECIFIED_DEFAULTS;

		expect({
			session: safeDefaultOf("session"),
			rateLimit: safeDefaultOf("rateLimit"),
			password: safeDefaultOf("password"),
			sessionMetadata: safeDefaultOf("sessionMetadata"),
			recoveryCodes: safeDefaultOf("recoveryCodes"),
			totp: safeDefaultOf("totp"),
			trustedProxies: safeDefaultOf("trustedProxies"),
			plugins: safeDefaultOf("plugins"),
		}).toStrictEqual({
			session: `idle ${session.idleTimeout}, absolute ${session.absoluteTimeout}, freshness ${session.freshnessWindow}, SameSite=Lax`,
			rateLimit: `per address ${perIpAddress.capacity} @ 1 per 2 s, per account ${perAccount.capacity} @ 1 per 300 s`,
			password: `argon2id m=${argon2id.memoryKiB}, t=${argon2id.iterations}, p=${argon2id.parallelism}`,
			sessionMetadata: SPECIFIED_DEFAULTS.sessionMetadata,
			recoveryCodes: `${recoveryCodes.count} codes in groups of ${recoveryCodes.groupSize}`,
			totp: `issuer required, tolerance ${SPECIFIED_DEFAULTS.totpToleranceInSteps} step`,
			trustedProxies: "[]",
			plugins: "[]",
		});
	});
});

const configurationSource = fileURLToPath(new URL("../src/core/auth/config.ts", import.meta.url));
const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));

function optionKeysWrittenInTheConfigurationType(): readonly string[] {
	const source = readFileSync(configurationSource, "utf8");
	const base = source.slice(source.indexOf("export interface BaseConfig"));
	const body = base.slice(0, base.indexOf("\n}"));
	return [
		...[...body.matchAll(/^\treadonly (\w+)\??:/gm)].map((match) => String(match[1])),
		"recoveryCodes",
	];
}

describe("the options that must not exist at all (S-DEFAULT-2, S-DEFAULT-3)", () => {
	const FORBIDDEN = [
		"disablePkce",
		"disableOriginCheck",
		"disableRateLimit",
		"skipStateCheck",
		"revokeSessionsOnPasswordReset",
		"revokeOtherSessions",
		"cookieCache",
		"requireEmailVerification",
		"minimumResponseTime",
	];
	//t-default-3 names the four switches and their variants, so a spelling is matched as well as a name
	const FORBIDDEN_VARIANT =
		/\b(?:disable|skip|bypass|without|no|allowInsecure|unsafe|ignore)_?(?:pkce|state|origin|rate_?limit|csrf)\w*/gi;

	function forbiddenNamesIn(text: string): readonly string[] {
		return [
			...FORBIDDEN.filter((name) => text.toLowerCase().includes(name.toLowerCase())),
			...[...text.matchAll(FORBIDDEN_VARIANT)].map((match) => match[0]),
		];
	}

	/**
	 * The option type is not one file: `password`, `oauth`, `plugins`, `session` and the route a
	 * plugin declares are each typed elsewhere and reach `BaseConfig` by import. The scan follows
	 * every relative import from `core/auth/config.ts`, so a switch added to any of them is seen.
	 */
	function filesTheConfigurationTypeReaches(): readonly string[] {
		const reached = new Set<string>();
		const pending = [configurationSource];
		for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
			if (reached.has(file)) {
				continue;
			}
			reached.add(file);
			for (const match of readFileSync(file, "utf8").matchAll(/from "(\.{1,2}\/[^"]+)\.js"/g)) {
				pending.push(resolve(dirname(file), `${String(match[1])}.ts`));
			}
		}
		return [...reached];
	}

	const sources = [
		...new Set([
			...filesTheConfigurationTypeReaches(),
			...readdirSync(fileURLToPath(new URL("../src/core/auth", import.meta.url)), {
				recursive: true,
				withFileTypes: true,
			})
				.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
				.map((entry) => resolve(entry.parentPath, entry.name)),
		]),
	];

	it("names none of them anywhere in the option type or the assembly, over a set that is not empty", () => {
		const hits = sources.flatMap((path) =>
			forbiddenNamesIn(readFileSync(path, "utf8")).map(
				(name) => `${relative(sourceRoot, path)}: ${name}`,
			),
		);

		expect(sources.length).toBeGreaterThanOrEqual(7);
		expect(hits).toStrictEqual([]);
	});

	it("reaches the option types of every feature, not only the assembly", () => {
		const reached = filesTheConfigurationTypeReaches().map((path) => relative(sourceRoot, path));

		expect(reached).toEqual(
			expect.arrayContaining([
				"core/auth/config.ts",
				"core/password/config.ts",
				"core/oauth/config.ts",
				"core/plugin/config.ts",
				"core/session/config.ts",
				"core/identity/configuration.ts",
				"core/http/route.ts",
				"core/http/rate-limit.ts",
			]),
		);
	});

	it("finds a planted switch, so a clean scan means found nothing rather than looked nowhere", () => {
		expect(forbiddenNamesIn("readonly disablePkce?: boolean")).toContain("disablePkce");
		expect(forbiddenNamesIn("readonly skipOriginCheck?: true")).toContain("skipOriginCheck");
		expect(forbiddenNamesIn("readonly no_rate_limit?: true")).toContain("no_rate_limit");
		expect(forbiddenNamesIn("readonly noRateLimit?: true")).toContain("noRateLimit");
		expect(forbiddenNamesIn("readonly ignoreState: true")).toContain("ignoreState");
	});

	it("reads the forbidden list from a constant rather than from a literal in the assertion", () => {
		expect(FORBIDDEN).toContain("disableOriginCheck");
		expect(FORBIDDEN.length).toBeGreaterThanOrEqual(4);
	});
});

describe("the events after which a session is re-issued (S-FIX-1, T-FIX-1)", () => {
	it("names eight, and says of each whether it takes the other sessions with it", () => {
		expect(TRUST_LEVEL_EVENTS).toHaveLength(8);
		expect(Object.keys(TRUST_LEVEL_EVENT_REVOKES_OTHER_SESSIONS).sort()).toStrictEqual(
			[...TRUST_LEVEL_EVENTS].sort(),
		);
		// E-243: exactly the two credential changes revoke; the rest re-issue and leave the others.
		expect(
			TRUST_LEVEL_EVENTS.filter((event) => TRUST_LEVEL_EVENT_REVOKES_OTHER_SESSIONS[event]),
		).toStrictEqual(["password_change", "password_reset"]);
	});
});

describe("the freshness window is decided once (E-233)", () => {
	it("gives the pipeline the window the session settings hold, not a second one", () => {
		const auth = start({ session: { freshnessWindow: "90s" } })();
		const settings = sessionSettingsOf({ freshnessWindow: "90s" });

		expect(
			(auth as { http: { freshnessWindowInSeconds: number } }).http.freshnessWindowInSeconds,
		).toBe(settings.freshnessWindowMs / 1000);
	});

	it("derives the default window the same way", () => {
		const auth = start()();

		expect(
			(auth as { http: { freshnessWindowInSeconds: number } }).http.freshnessWindowInSeconds,
		).toBe(sessionSettingsOf().freshnessWindowMs / 1000);
	});
});
