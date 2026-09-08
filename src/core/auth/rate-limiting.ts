import type { Clock } from "../http/environment.js";
import type {
	BucketRule,
	RateLimitDecision,
	RateLimiter,
	RateLimitRequest,
	RateLimitScope,
} from "../http/rate-limit.js";
import type { RateAlert, RateLimitConfig } from "./config.js";

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

function keyOf(routeName: string, scope: RateLimitScope): string {
	return scope.kind === "ip_address"
		? `${routeName}|address|${scope.ipAddress ?? "unknown"}`
		: `${routeName}|account|${scope.accountIdentifier}`;
}

interface Bucket {
	tokens: number;
	updatedAtMs: number;
}

const MINUTE_IN_MILLISECONDS = 60_000;

/**
 * The counters 3.9 asks for live in `velve.rate_bucket` and are built by another feature, whose
 * files this one may not write. This is the bucket the assembly uses until that lands: the same
 * arithmetic, held in this process instead of in the database.
 *
 * It is weaker, and it says so — the assembly logs it as a weakening under S-DEFAULT-1, because a
 * counter per process is a counter an attacker divides by the number of processes. Replacing it is
 * one import.
 */
export function createInProcessRateLimiter(input: {
	readonly clock: Clock;
	readonly globalPerRoute: RateLimitConfig["globalPerRoute"];
}): RateLimiter {
	const buckets = new Map<string, Bucket>();
	const routeCounts = new Map<string, { count: number; windowStartedAtMs: number }>();

	function refilled(bucket: Bucket, rule: BucketRule, nowMs: number): number {
		const elapsedSeconds = (nowMs - bucket.updatedAtMs) / 1000;
		return Math.min(rule.capacity, bucket.tokens + elapsedSeconds * rule.refillPerSecond);
	}

	function countTowardsTheAlert(routeName: string, nowMs: number): void {
		const seen = routeCounts.get(routeName);
		if (seen === undefined || nowMs - seen.windowStartedAtMs >= MINUTE_IN_MILLISECONDS) {
			routeCounts.set(routeName, { count: 1, windowStartedAtMs: nowMs });
			return;
		}
		seen.count += 1;
		if (seen.count === input.globalPerRoute.alertThresholdPerMinute) {
			const alert: RateAlert = {
				routeName,
				requestsInLastMinute: seen.count,
				observedAt: input.clock.now(),
			};
			// L-5: the global counter never refuses, it reports.
			input.globalPerRoute.onAlert(alert);
		}
	}

	return {
		consume(request: RateLimitRequest): Promise<RateLimitDecision> {
			const nowMs = input.clock.now().getTime();
			countTowardsTheAlert(request.routeName, nowMs);

			const key = keyOf(request.routeName, request.scope);
			const bucket = buckets.get(key) ?? { tokens: request.rule.capacity, updatedAtMs: nowMs };
			const available = refilled(bucket, request.rule, nowMs);
			if (available < 1) {
				buckets.set(key, { tokens: available, updatedAtMs: nowMs });
				const secondsUntilOneToken = (1 - available) / request.rule.refillPerSecond;
				return Promise.resolve({
					allowed: false,
					retryAfterSeconds: Math.ceil(secondsUntilOneToken),
				});
			}
			buckets.set(key, { tokens: available - 1, updatedAtMs: nowMs });
			return Promise.resolve({ allowed: true });
		},
	};
}
