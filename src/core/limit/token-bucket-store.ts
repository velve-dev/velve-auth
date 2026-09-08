import type { Driver } from "../db/driver.js";
import { qualifiedTableName } from "../db/identifier.js";

interface TokenBucketStoreOptions {
	readonly driver: Driver;
	readonly schema: string;
}

interface TokenBucketDraw {
	readonly bucketKey: string;
	readonly capacity: number;
	readonly refillPerSecond: number;
	readonly lifetimeInSeconds: number;
	readonly observedAt: Date;
}

interface TokenBucketStore {
	draw(input: TokenBucketDraw): Promise<number>;
}

export class RateBucketUnwritten extends Error {
	readonly code = "rate_bucket_unwritten";

	constructor() {
		super("The token bucket statement returned no row.");
		this.name = "RateBucketUnwritten";
	}
}

/** A driver may hand a `real` column back decoded or as the text PostgreSQL sent; both arrive
 * here, and a bucket that reads as nothing at all must not read as a full one. */
function tokensOf(value: unknown): number {
	const tokens = Number(value);
	if (value === null || value === undefined || Number.isNaN(tokens)) {
		throw new RateBucketUnwritten();
	}
	return tokens;
}

/**
 * S-RATE-6: one statement, so *n* concurrent draws against a capacity of *L* leave at most *L*
 * of them non-negative. The refilled level is floored at zero before the draw, which bounds a
 * refused bucket at −1 — without it a flood drives the level arbitrarily negative and locks the
 * rightful owner out for as long as it takes to climb back, which is the lockout S-RATE-7
 * forbids. Elapsed time is floored against a clock that moved backwards, which it can because the
 * instant is the process's rather than the database's (E-380, E-381).
 */
export function createTokenBucketStore(options: TokenBucketStoreOptions): TokenBucketStore {
	const table = qualifiedTableName(options.schema, "rate_bucket");

	const drawStatement = `INSERT INTO ${table} (bucket_key, tokens, updated_at, expires_at)
/* no owner predicate: S-RATE-7 — a rate bucket is keyed by a digest and has no owner column */
VALUES ($1, $2 - 1, $5::timestamptz, $5::timestamptz + make_interval(secs => $3::double precision))
ON CONFLICT (bucket_key) DO UPDATE
SET tokens = LEAST($2, GREATEST(0, ${table}.tokens
      + GREATEST(0, EXTRACT(EPOCH FROM $5::timestamptz - ${table}.updated_at)) * $4)) - 1,
    updated_at = $5::timestamptz,
    expires_at = $5::timestamptz + make_interval(secs => $3::double precision)
RETURNING tokens`;

	return {
		async draw(input) {
			const [row] = await options.driver.query<{ tokens: unknown }>(drawStatement, [
				input.bucketKey,
				input.capacity,
				input.lifetimeInSeconds,
				input.refillPerSecond,
				input.observedAt.toISOString(),
			]);
			if (row === undefined) {
				throw new RateBucketUnwritten();
			}
			return tokensOf(row.tokens);
		},
	};
}
