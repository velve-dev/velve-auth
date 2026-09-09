import type { Driver } from "../src/core/db/driver.js";
import type { Clock, HttpEnvironment } from "../src/core/http/environment.js";
import type { RateLimiter, RateLimitRequest, RateLimitRule } from "../src/core/http/rate-limit.js";
import { type AnyRoute, defineRoute } from "../src/core/http/route.js";
import { object, string } from "../src/core/http/validators.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { rootKeyProvider } from "../src/core/keys/root-key-provider.js";
import { createRateLimiter, type RateLimiterConfig } from "../src/core/limit/index.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { TEST_PLUGIN_CONTEXT } from "./http-fixtures.js";
import { generateRootKey } from "./keys-fixtures.js";

const ALLOWED_ORIGIN = "https://app.example.com";
const START_OF_TEST_TIME = new Date("2026-01-01T12:00:00.000Z");

export interface MovableClock {
	now(): Date;
	advanceBySeconds(seconds: number): void;
}

export function movableClock(from: Date = START_OF_TEST_TIME): MovableClock {
	let instant = from;
	return {
		now: () => instant,
		advanceBySeconds: (seconds) => {
			instant = new Date(instant.getTime() + seconds * 1000);
		},
	};
}

export interface CountedRateLimiter extends RateLimiter {
	readonly requests: readonly RateLimitRequest[];
}

/** T-RATE-4 counts skipped checks, which only a limiter that sees every call can report. */
function countingRateLimiter(inner: RateLimiter): CountedRateLimiter {
	const requests: RateLimitRequest[] = [];
	return {
		requests,
		consume: async (request) => {
			requests.push(request);
			return inner.consume(request);
		},
	};
}

export const NO_LIMIT: RateLimitRule = { perIpAddress: "none", perAccount: "none" };

type FailedSignInWork = (identifier: string) => Promise<void>;

interface RouteTableOptions {
	readonly signIn: RateLimitRule;
	readonly probe: RateLimitRule;
	readonly onCredentialCheck?: FailedSignInWork;
}

/** The two shapes the requirements need: a route with an account bucket behind an address
 * bucket, and one with an address bucket alone. */
function testRoutes(options: RouteTableOptions): readonly AnyRoute[] {
	const signIn = defineRoute({
		name: "signIn.password",
		method: "POST",
		path: "/sign-in/password",
		input: object({ identifier: string(), password: string() }),
		errors: ["invalid_credentials", "rate_limited"] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: options.signIn,
		handler: async (input, context) => {
			await context.enforceAccountRateLimit(input.identifier.trim().toLowerCase());
			await options.onCredentialCheck?.(input.identifier);
			return { signedIn: input.password === "correct-horse" };
		},
	});

	const probe = defineRoute({
		name: "probe",
		method: "POST",
		path: "/probe",
		input: object({}),
		errors: ["rate_limited"] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: options.probe,
		handler: async () => ({ seen: true }),
	});

	return [signIn, probe];
}

function testHttpEnvironment(
	routes: readonly AnyRoute[],
	rateLimiter: RateLimiter,
	clock: Clock,
): HttpEnvironment {
	return {
		pluginContextOf: () => TEST_PLUGIN_CONTEXT,
		routes,
		origins: [ALLOWED_ORIGIN],
		trustedProxies: [],
		cookieSameSite: "lax",
		sessionCookieMaximumAgeInSeconds: 2_592_000,
		freshnessWindowInSeconds: 900,
		callers: {
			resolveSession: async () => {
				throw new Error("no test route resolves a session");
			},
			resolvePending: async () => {
				throw new Error("no test route resolves a pending authentication");
			},
		},
		rateLimiter,
		clock: { now: () => clock.now() },
		log: () => undefined,
	};
}

export interface Harness {
	readonly connection: TestConnection;
	readonly schema: string;
	readonly clock: MovableClock;
	readonly limiter: CountedRateLimiter;
	readonly handle: (request: Request) => Promise<Response>;
	readonly close: () => Promise<void>;
}

interface HarnessOptions extends RouteTableOptions {
	readonly config?: RateLimiterConfig;
	readonly connectionAddress?: (request: Request) => string | null;
}

export async function openLimitHarness(options: HarnessOptions): Promise<Harness> {
	const migrated = await openMigratedSchema("velve_rate");
	const clock = movableClock();
	const limiter = countingRateLimiter(
		limiterOn(migrated.connection, migrated.schema, clock, options.config),
	);
	const routes = testRoutes(options);
	const environment = testHttpEnvironment(routes, limiter, clock);
	const handlerOptions =
		options.connectionAddress === undefined ? {} : { connectionAddress: options.connectionAddress };

	return {
		connection: migrated.connection,
		schema: migrated.schema,
		clock,
		limiter,
		handle: toWebHandler({ http: environment }, handlerOptions),
		close: async () => {
			await dropSchema(migrated.connection, migrated.schema);
			await migrated.connection.close();
		},
	};
}

export function limiterOn(
	driver: Driver,
	schema: string,
	clock: Clock,
	config?: RateLimiterConfig,
): RateLimiter {
	const keys = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });
	const options = { driver, keys, schema, clock: { now: () => clock.now() } };
	return createRateLimiter(config === undefined ? options : { ...options, config });
}

export function signInRequest(
	path: string,
	body: { identifier: string; password: string },
): Request {
	return new Request(`https://api.example.com${path}`, {
		method: "POST",
		headers: { origin: ALLOWED_ORIGIN, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

export function probeRequest(headers: Readonly<Record<string, string>> = {}): Request {
	return new Request("https://api.example.com/probe", {
		method: "POST",
		headers: { origin: ALLOWED_ORIGIN, "content-type": "application/json", ...headers },
		body: "{}",
	});
}

interface BucketRow {
	readonly bucket_key: string;
	readonly tokens: unknown;
}

export function readBuckets(driver: Driver, schema: string): Promise<BucketRow[]> {
	return driver.query<BucketRow>(
		`SELECT bucket_key, tokens FROM ${schema}.rate_bucket ORDER BY bucket_key`,
		[],
	);
}
