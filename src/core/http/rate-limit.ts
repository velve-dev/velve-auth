export interface BucketRule {
	readonly capacity: number;
	readonly refillPerSecond: number;
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
