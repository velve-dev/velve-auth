import type { FrozenContext } from "../plugin/config.js";
import type { CallerResolver } from "./caller.js";
import { type CookiePolicy, type CookieSameSite, DEFAULT_COOKIE_NAMES } from "./cookies.js";
import type { RateLimiter } from "./rate-limit.js";
import type { AnyRoute, RouteMetadata } from "./route.js";

export interface Clock {
	now(): Date;
}

export type LogLevel = "info" | "warn" | "error";

export interface HttpEnvironment {
	readonly routes: readonly AnyRoute[];
	readonly origins: readonly string[];
	/** A.2: the CIDR ranges whose `X-Forwarded-For` counts; empty means the connection address does. */
	readonly trustedProxies: readonly string[];
	readonly cookieSameSite: CookieSameSite;
	readonly sessionCookieMaximumAgeInSeconds: number;
	readonly freshnessWindowInSeconds: number;
	readonly callers: CallerResolver;
	/** Which frozen context a route's handler is given; a route the assembly did not register gets the core one. */
	readonly pluginContextOf: (route: RouteMetadata) => FrozenContext;
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
