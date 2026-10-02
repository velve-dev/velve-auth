import type { Driver } from "../db/driver.js";
import type { Clock } from "../http/environment.js";
import type {
	BucketRule,
	RateLimitDecision,
	RateLimiter,
	RateLimitRequest,
} from "../http/rate-limit.js";
import type { KeyProvider } from "../keys/provider.js";
import { accountBucketKey, addressBucketKey } from "./bucket-key.js";
import { createRouteFloodCounter, type RouteFloodWatch } from "./route-flood.js";
import { createTokenBucketStore } from "./token-bucket-store.js";

export interface RateLimiterConfig {
	readonly routeFlood?: RouteFloodWatch;
}

export interface RateLimiterOptions {
	readonly driver: Driver;
	readonly keys: KeyProvider;
	readonly schema: string;
	readonly clock: Clock;
	readonly config?: RateLimiterConfig;
}

const SHORTEST_BUCKET_LIFETIME_IN_SECONDS = 60;

//a bucket that takes longer than a day to refill would be a lockout (E-385)
const LONGEST_BUCKET_LIFETIME_IN_SECONDS = 86_400;

//a bucket row must outlive the time its bucket needs to refill from empty (E-385)
function bucketLifetimeInSeconds(rule: BucketRule): number {
	const untilFull = rule.capacity / rule.refillPerSecond;
	if (!Number.isFinite(untilFull) || untilFull > LONGEST_BUCKET_LIFETIME_IN_SECONDS) {
		return LONGEST_BUCKET_LIFETIME_IN_SECONDS;
	}
	return Math.max(SHORTEST_BUCKET_LIFETIME_IN_SECONDS, Math.ceil(untilFull));
}

//a refusal without a retry hint is already an answer a caller must handle (E-166)
function secondsUntilNextToken(tokens: number, refillPerSecond: number): number | null {
	if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
		return null;
	}
	return Math.max(1, Math.ceil((1 - tokens) / refillPerSecond));
}

function decisionFor(tokens: number, rule: BucketRule): RateLimitDecision {
	if (tokens >= 0) {
		return { allowed: true };
	}
	const retryAfterSeconds = secondsUntilNextToken(tokens, rule.refillPerSecond);
	return retryAfterSeconds === null ? { allowed: false } : { allowed: false, retryAfterSeconds };
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
	const store = createTokenBucketStore({ driver: options.driver, schema: options.schema });
	const watch = options.config?.routeFlood;
	const floodCounter = watch === undefined ? null : createRouteFloodCounter(watch);

	async function bucketKeyFor(request: RateLimitRequest): Promise<string> {
		if (request.scope.kind === "ip_address") {
			return addressBucketKey(request.routeName, request.scope.ipAddress);
		}
		return accountBucketKey(options.keys, request.routeName, request.scope.accountIdentifier);
	}

	return {
		async consume(request) {
			const observedAt = options.clock.now();
			if (request.scope.kind === "ip_address") {
				floodCounter?.observe(request.routeName, observedAt);
			}

			const tokens = await store.draw({
				bucketKey: await bucketKeyFor(request),
				capacity: request.rule.capacity,
				refillPerSecond: request.rule.refillPerSecond,
				lifetimeInSeconds: bucketLifetimeInSeconds(request.rule),
				observedAt,
			});
			return decisionFor(tokens, request.rule);
		},
	};
}
