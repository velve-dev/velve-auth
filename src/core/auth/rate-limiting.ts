import type { HttpEnvironment } from "../http/environment.js";
import type { BucketRule } from "../http/rate-limit.js";
import type { RouteFloodWatch } from "../limit/index.js";
import type { RateAlert, RateLimitConfig } from "./config.js";

type RouteAlarm = (alert: RateAlert) => void;

const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
	perIpAddress: { capacity: 30, refillPerSecond: 0.5 },
	perAccount: { capacity: 5, refillPerSecond: 1 / 300 },
	globalPerRoute: { alertThresholdPerMinute: 6000, onAlert: () => undefined },
};

export function rateLimitConfigOf(
	config: Partial<RateLimitConfig> = {},
	defaultRouteAlarm: RouteAlarm = DEFAULT_RATE_LIMIT_CONFIG.globalPerRoute.onAlert,
): RateLimitConfig {
	return {
		perIpAddress: config.perIpAddress ?? DEFAULT_RATE_LIMIT_CONFIG.perIpAddress,
		perAccount: config.perAccount ?? DEFAULT_RATE_LIMIT_CONFIG.perAccount,
		globalPerRoute: config.globalPerRoute ?? {
			...DEFAULT_RATE_LIMIT_CONFIG.globalPerRoute,
			onAlert: defaultRouteAlarm,
		},
	};
}

const ROUTE_ALARM_INTERVAL_MS = 60_000;

//a flooded route is reported once a minute at most so the alarm cannot flood the log itself (E-2672)
export function routeAlarmReportedTo(sink: HttpEnvironment["log"]): RouteAlarm {
	const lastReportedAt = new Map<string, number>();
	return (alert) => {
		const observedAt = alert.observedAt.getTime();
		const previous = lastReportedAt.get(alert.routeName);
		if (previous !== undefined && observedAt - previous < ROUTE_ALARM_INTERVAL_MS) {
			return;
		}
		lastReportedAt.set(alert.routeName, observedAt);
		sink("warn", "a route is taking more requests than its alert threshold", {
			routeName: alert.routeName,
			requestsInLastMinute: alert.requestsInLastMinute,
			observedAt: alert.observedAt.toISOString(),
		});
	};
}

const SECONDS_IN_A_MINUTE = 60;

//a threshold of N a minute is the same as a bucket of N refilling at N/60 a second (E-356)
export function routeFloodWatchOf(config: RateLimitConfig): RouteFloodWatch {
	const rule: BucketRule = {
		capacity: config.globalPerRoute.alertThresholdPerMinute,
		refillPerSecond: config.globalPerRoute.alertThresholdPerMinute / SECONDS_IN_A_MINUTE,
	};
	return {
		rule,
		//the observed count matches the threshold per minute to within one refill (E-356)
		onAlert: (alert) =>
			config.globalPerRoute.onAlert({
				routeName: alert.routeName,
				requestsInLastMinute: alert.addressChecksObserved,
				observedAt: alert.observedAt,
			}),
	};
}
