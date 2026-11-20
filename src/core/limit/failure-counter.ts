import type { Driver } from "../db/driver.js";
import { qualifiedTableName } from "../db/identifier.js";

/** the address counter of a sign-in and, where an identifier names an account, its account counter */
export type CounterKeys = readonly [address: string, account?: string];

/** counts failed sign-ins per key and forgets one failure every hour, so a counter never locks anyone out */
interface FailureCounters {
	highestOf(counterKeys: CounterKeys, observedAt: Date): Promise<number>;
	record(counterKeys: CounterKeys, observedAt: Date): Promise<void>;
}

const SECONDS_PER_FORGOTTEN_FAILURE = 3600;

interface FailureCounterOptions {
	readonly driver: Driver;
	readonly schema: string;
	/** the count a counter stops at, so it is forgotten within a bounded time */
	readonly ceiling: number;
}

interface HighestRow {
	readonly failures: unknown;
}

//a counter decays from the clock the rate buckets read, one failure an hour (E-3667)
export function createFailureCounters(options: FailureCounterOptions): FailureCounters {
	const table = qualifiedTableName(options.schema, "rate_bucket");
	const decayed = `GREATEST(0, ${table}.tokens - GREATEST(0, EXTRACT(EPOCH FROM $2::timestamptz - ${table}.updated_at)) / $3::double precision)`;
	const afterThisFailure = `LEAST($4::double precision, ${decayed} + 1)`;

	const recordStatement = `INSERT INTO ${table} (bucket_key, tokens, updated_at, expires_at)
/* no owner predicate: S-RATE-7, a failure counter is keyed by a digest and has no owner column */
VALUES ($1, 1, $2::timestamptz, $2::timestamptz + make_interval(secs => $3::double precision))
ON CONFLICT (bucket_key) DO UPDATE
SET tokens = ${afterThisFailure},
    updated_at = $2::timestamptz,
    expires_at = $2::timestamptz + make_interval(secs => ${afterThisFailure} * $3::double precision)`;

	const highestStatement = `SELECT COALESCE(MAX(${decayed}), 0) AS failures
FROM ${table}
WHERE ${table}.bucket_key IN ($1, $4)`;

	return {
		async highestOf([address, account], observedAt) {
			const [row] = await options.driver.query<HighestRow>(highestStatement, [
				address,
				observedAt.toISOString(),
				SECONDS_PER_FORGOTTEN_FAILURE,
				account ?? address,
			]);
			const failures = Number(row?.failures);
			//a counter the driver did not return must read as reached and never as empty
			return Number.isFinite(failures) ? failures : Number.POSITIVE_INFINITY;
		},

		async record(counterKeys, observedAt) {
			for (const counterKey of counterKeys) {
				if (counterKey !== undefined) {
					await options.driver.query(recordStatement, [
						counterKey,
						observedAt.toISOString(),
						SECONDS_PER_FORGOTTEN_FAILURE,
						options.ceiling,
					]);
				}
			}
		},
	};
}
