import type { BucketRule } from "../http/rate-limit.js";
import type { RouteFloodWatch } from "../limit/index.js";
import type { RateLimitConfig } from "./config.js";

const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
	perIpAddress: { capacity: 10, refillPerSecond: 0.1 },
	perAccount: { capacity: 5, refillPerSecond: 0.01 },
	globalPerRoute: { alertThresholdPerMinute: 6000, onAlert: () => undefined },
};

export function rateLimitConfigOf(config: Partial<RateLimitConfig> = {}): RateLimitConfig {
	return {
		perIpAddress: config.perIpAddress ?? DEFAULT_RATE_LIMIT_CONFIG.perIpAddress,
		perAccount: config.perAccount ?? DEFAULT_RATE_LIMIT_CONFIG.perAccount,
		globalPerRoute: config.globalPerRoute ?? DEFAULT_RATE_LIMIT_CONFIG.globalPerRoute,
	};
}

const SECONDS_IN_A_MINUTE = 60;

/**
 * 3.15 A.6 states the global counter as a threshold per minute; `core/limit` takes a bucket rule
 * (E-380). A threshold of N a minute is a bucket of N refilling at N/60 a second, which is the same
 * statement in the other module's vocabulary.
 */
export function routeFloodWatchOf(config: RateLimitConfig): RouteFloodWatch {
	const rule: BucketRule = {
		capacity: config.globalPerRoute.alertThresholdPerMinute,
		refillPerSecond: config.globalPerRoute.alertThresholdPerMinute / SECONDS_IN_A_MINUTE,
	};
	return {
		rule,
		// `addressChecksObserved` counts the checks that drained a bucket which refills at exactly
		// the declared threshold per minute, so it is that figure to within one refill (E-356).
		onAlert: (alert) =>
			config.globalPerRoute.onAlert({
				routeName: alert.routeName,
				requestsInLastMinute: alert.addressChecksObserved,
				observedAt: alert.observedAt,
			}),
	};
}
