import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import type { HttpEnvironment, LogLevel } from "../src/core/http/environment.js";
import type { ConcealedError } from "../src/core/http/error-map.js";
import type { RateLimitRequest } from "../src/core/http/rate-limit.js";
import { type AnyRoute, defineRoute } from "../src/core/http/route.js";
import { object, optional, string } from "../src/core/http/validators.js";

export const ALLOWED_ORIGIN = "https://app.example.com";

const NOW = new Date("2026-01-01T12:00:00.000Z");

const echoRoute = defineRoute({
	name: "test.echo",
	method: "POST",
	path: "/test/echo",
	input: object({ value: string() }),
	errors: ["invalid_input"] as const,
	caller: "anonymous",
	freshness: "not_required",
	originCheck: "checked",
	rateLimit: { perIpAddress: { capacity: 10, refillPerSecond: 1 }, perAccount: "none" },
	handler: async (input) => ({ echoed: input.value }),
});

export const signInRoute = defineRoute({
	name: "test.signIn",
	method: "POST",
	path: "/test/sign-in",
	input: object({ identifier: string() }),
	errors: ["invalid_credentials", "rate_limited"] as const,
	caller: "anonymous",
	freshness: "not_required",
	originCheck: "checked",
	rateLimit: {
		perIpAddress: { capacity: 10, refillPerSecond: 0.1 },
		perAccount: { capacity: 5, refillPerSecond: 0.01 },
	},
	handler: async (input, context) => {
		await context.enforceAccountRateLimit(input.identifier);
		return { status: "signed_in", sessionToken: "session-token-value" };
	},
});

const signOutRoute = defineRoute({
	name: "test.signOut",
	method: "POST",
	path: "/test/sign-out",
	input: object({}),
	errors: [] as const,
	caller: "anonymous",
	freshness: "not_required",
	originCheck: "checked",
	rateLimit: { perIpAddress: "none", perAccount: "none" },
	handler: async (_input, context) => {
		context.cookies.clearSession();
	},
});

const sessionRoute = defineRoute({
	name: "test.session.read",
	method: "GET",
	path: "/test/session",
	input: object({}),
	errors: ["session_required"] as const,
	caller: "session",
	freshness: "not_required",
	originCheck: "checked",
	rateLimit: { perIpAddress: "none", perAccount: "none" },
	handler: async (_input, context) => ({ userId: context.session?.userId ?? null }),
});

const freshRoute = defineRoute({
	name: "test.session.fresh",
	method: "POST",
	path: "/test/fresh",
	input: object({}),
	errors: ["session_required", "freshness_required"] as const,
	caller: "session",
	freshness: "required",
	originCheck: "checked",
	rateLimit: { perIpAddress: "none", perAccount: "none" },
	handler: async () => ({ confirmed: true }),
});

const pendingRoute = defineRoute({
	name: "test.factor.verify",
	method: "POST",
	path: "/test/factor/verify",
	input: object({}),
	errors: ["invalid_pending_authentication"] as const,
	caller: "pending",
	freshness: "not_required",
	originCheck: "checked",
	rateLimit: { perIpAddress: "none", perAccount: "none" },
	handler: async (_input, context) => ({
		attemptsRemaining: context.pending?.attemptsRemaining ?? null,
	}),
});

export const callbackRoute = defineRoute({
	name: "test.oauth.callback",
	method: "GET",
	path: "/test/callback/:provider",
	input: object({ provider: string(), code: optional(string()) }),
	errors: ["oauth_flow_invalid"] as const,
	caller: "anonymous",
	freshness: "not_required",
	originCheck: "exempt",
	rateLimit: { perIpAddress: "none", perAccount: "none" },
	handler: async (input) => ({ provider: input.provider, code: input.code ?? null }),
});

export const failingRoute = defineRoute({
	name: "test.broken",
	method: "POST",
	path: "/test/broken",
	input: object({}),
	errors: [] as const,
	caller: "anonymous",
	freshness: "not_required",
	originCheck: "checked",
	rateLimit: { perIpAddress: "none", perAccount: "none" },
	handler: async () => {
		throw new Error("the connection to 10.0.0.4 was refused");
	},
});

const maintenanceRoute = defineRoute({
	name: "test.maintenance.sweep",
	method: "POST",
	path: "/test/maintenance/sweep",
	input: object({}),
	errors: [] as const,
	caller: "server_only",
	freshness: "not_required",
	originCheck: "checked",
	rateLimit: { perIpAddress: "none", perAccount: "none" },
	handler: async () => ({ removed: 0 }),
});

const TEST_ROUTES: readonly AnyRoute[] = [
	echoRoute,
	signInRoute,
	signOutRoute,
	sessionRoute,
	freshRoute,
	pendingRoute,
	callbackRoute,
	maintenanceRoute,
];

interface LogEntry {
	readonly level: LogLevel;
	readonly message: string;
	readonly fields: Readonly<Record<string, unknown>> | undefined;
}

interface Harness {
	readonly environment: HttpEnvironment;
	readonly rateLimitRequests: RateLimitRequest[];
	readonly logs: LogEntry[];
}

interface HarnessOptions {
	readonly routes?: readonly AnyRoute[];
	readonly origins?: readonly string[];
	readonly sessionAgeInSeconds?: number;
	readonly sessionFailure?: ConcealedError;
	readonly rateLimitAllows?: boolean;
}

export function createHarness(options: HarnessOptions = {}): Harness {
	const rateLimitRequests: RateLimitRequest[] = [];
	const logs: LogEntry[] = [];
	const sessionAgeInSeconds = options.sessionAgeInSeconds ?? 0;

	const environment: HttpEnvironment = {
		routes: options.routes ?? TEST_ROUTES,
		origins: options.origins ?? [ALLOWED_ORIGIN],
		cookieNames: DEFAULT_COOKIE_NAMES,
		cookieSameSite: "lax",
		sessionCookieMaximumAgeInSeconds: 2_592_000,
		freshnessWindowInSeconds: 900,
		callers: {
			resolveSession: async (sessionToken) => {
				if (options.sessionFailure !== undefined) {
					throw options.sessionFailure;
				}
				return {
					id: "session-id",
					userId: `user-of-${sessionToken}`,
					createdAt: new Date(NOW.getTime() - sessionAgeInSeconds * 1000),
					lastUsedAt: NOW,
					idleExpiresAt: new Date(NOW.getTime() + 604_800_000),
					absoluteExpiresAt: new Date(NOW.getTime() + 2_592_000_000),
					factors: ["password"],
					ipAddress: null,
					userAgent: null,
					isCurrent: true,
				};
			},
			resolvePending: async () => ({
				factorsCompleted: ["password"],
				availableFactors: ["totp"],
				attemptsRemaining: 5,
				expiresAt: new Date(NOW.getTime() + 300_000),
			}),
		},
		rateLimiter: {
			consume: async (request) => {
				rateLimitRequests.push(request);
				return { allowed: options.rateLimitAllows ?? true, retryAfterSeconds: 30 };
			},
		},
		clock: { now: () => NOW },
		log: (level, message, fields) => {
			logs.push({ level, message, fields });
		},
	};

	return { environment, rateLimitRequests, logs };
}

export function requestTo(
	path: string,
	init: { method?: string; origin?: string | null; cookie?: string; body?: unknown } = {},
): Request {
	const headers = new Headers();
	if (init.origin !== null) {
		headers.set("origin", init.origin ?? ALLOWED_ORIGIN);
	}
	if (init.cookie !== undefined) {
		headers.set("cookie", init.cookie);
	}
	const method = init.method ?? "POST";
	if (method === "GET") {
		return new Request(`https://api.example.com${path}`, { method, headers });
	}
	headers.set("content-type", "application/json");
	return new Request(`https://api.example.com${path}`, {
		method,
		headers,
		body: JSON.stringify(init.body ?? {}),
	});
}
