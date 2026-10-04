export interface BucketRule {
	readonly capacity: number;
	readonly refillPerSecond: number;
}

//a bucket the limiter cannot count against must never reach it (S-DEFAULT-3)
export function isUsableBucketRule(rule: unknown): rule is BucketRule {
	if (typeof rule !== "object" || rule === null) {
		return false;
	}
	const { capacity, refillPerSecond } = rule as Partial<BucketRule>;
	return (
		typeof capacity === "number" &&
		typeof refillPerSecond === "number" &&
		Number.isFinite(capacity) &&
		Number.isFinite(refillPerSecond) &&
		capacity >= 0 &&
		refillPerSecond >= 0
	);
}

export interface RateLimitRule {
	readonly perIpAddress: BucketRule | "none";
	readonly perAccount: BucketRule | "none";
}

export type RateLimitScope =
	| { readonly kind: "ip_address"; readonly ipAddress: string | null }
	| { readonly kind: "account"; readonly accountIdentifier: string };

export interface RateLimitRequest {
	readonly routeName: string;
	readonly rule: BucketRule;
	readonly scope: RateLimitScope;
}

export interface RateLimitDecision {
	readonly allowed: boolean;
	readonly retryAfterSeconds?: number;
}

export interface RateLimiter {
	consume(request: RateLimitRequest): Promise<RateLimitDecision>;
}
