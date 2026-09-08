import type { CallerResolver } from "./caller.js";
import { type CookiePolicy, type CookieSameSite, DEFAULT_COOKIE_NAMES } from "./cookies.js";
import type { RateLimiter } from "./rate-limit.js";
import type { AnyRoute } from "./route.js";

export interface Clock {
	now(): Date;
}

export type LogLevel = "info" | "warn" | "error";

export interface HttpEnvironment {
	readonly routes: readonly AnyRoute[];
	readonly origins: readonly string[];
	readonly cookieSameSite: CookieSameSite;
	readonly sessionCookieMaximumAgeInSeconds: number;
	readonly freshnessWindowInSeconds: number;
	readonly callers: CallerResolver;
	readonly rateLimiter: RateLimiter;
	readonly clock: Clock;
	readonly log: (
		level: LogLevel,
		message: string,
		fields?: Readonly<Record<string, unknown>>,
	) => void;
}

export interface WebHandlerTarget {
	readonly http: HttpEnvironment;
}

export function cookiePolicyOf(environment: HttpEnvironment): CookiePolicy {
	return {
		names: DEFAULT_COOKIE_NAMES,
		sameSite: environment.cookieSameSite,
		sessionMaximumAgeInSeconds: environment.sessionCookieMaximumAgeInSeconds,
	};
}
