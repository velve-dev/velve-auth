import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import type { VelveAuthConfig } from "../src/core/auth/config.js";
import { SECURITY_OPTIONS } from "../src/core/auth/security-options.js";
import { VelveStartupError } from "../src/core/auth/startup.js";
import {
	TRUST_LEVEL_EVENT_REVOKES_OTHER_SESSIONS,
	TRUST_LEVEL_EVENTS,
} from "../src/core/auth/trust-level.js";
import type { Driver } from "../src/core/db/driver.js";
import { encodeBase64Url } from "../src/core/keys/base64url.js";
import { KeyError, rootKeyProvider } from "../src/core/keys/index.js";
import { sessionSettingsOf } from "../src/core/session/config.js";
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
	 * type half was unobserved for as long as it was broken (E-349).
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
	it("says nothing about an option left at its default beyond the one the assembly itself weakens", () => {
		const log = createLogSink();
		start({ log: log.write })();

		const weakened = log.lines.filter(
			(line) => line.message === "a security option is weaker than its default",
		);

		expect(weakened.map((line) => line.fields.option)).toStrictEqual(["rateLimit"]);
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
			"rateLimit",
			"session",
			"sessionMetadata",
			"trustedProxies",
		]);
		expect(new Set(weakened.map((line) => line.fields.option)).size).toBe(weakened.length);
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

const configurationSource = fileURLToPath(new URL("../src/core/auth/config.ts", import.meta.url));

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
	const sources = readdirSync(fileURLToPath(new URL("../src/core/auth", import.meta.url)), {
		recursive: true,
		withFileTypes: true,
	})
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => `${entry.parentPath}/${entry.name}`);

	it("names none of them anywhere in the assembly, over a set that is not empty", () => {
		const text = sources.map((path) => readFileSync(path, "utf8")).join("\n");

		expect(sources.length).toBeGreaterThanOrEqual(7);
		expect(FORBIDDEN.filter((name) => text.includes(name))).toStrictEqual([]);
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
