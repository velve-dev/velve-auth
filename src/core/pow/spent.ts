import type { Driver } from "../db/driver.js";
import { qualifiedTableName } from "../db/identifier.js";
import { type CheckedSolution, PROOF_OF_WORK_LIFETIME_IN_SECONDS } from "./challenge.js";

const utf8 = new TextEncoder();

type SpendOutcome = "spent_now" | "expired" | "spent_before";

interface SpendRow {
	readonly live: unknown;
	readonly spent_now: unknown;
}

/** spends a checked challenge once, deciding its expiry by the clock the sweep deletes by */
interface SpentChallenges {
	/** the expiry of a challenge handed out now, in whole seconds by the database clock */
	deadline(): Promise<Date>;
	spend(solution: CheckedSolution): Promise<SpendOutcome>;
}

interface DeadlineRow {
	readonly expires_at: unknown;
}

//the expiry is handed out and read by the database clock the sweep deletes by (E-3664)
export function createSpentChallenges(options: {
	readonly driver: Driver;
	readonly schema: string;
}): SpentChallenges {
	const table = qualifiedTableName(options.schema, "proof_of_work_spent");
	const spendStatement = `WITH deadline AS (
  SELECT to_timestamp($2::double precision) AS expires_at,
         to_timestamp($2::double precision) > now() AS live
), spent AS (
  INSERT INTO ${table} (challenge_sha256, expires_at)
  /* no owner predicate: S-RATE-10, a spent challenge belongs to no account */
  SELECT $1::bytea, deadline.expires_at FROM deadline WHERE deadline.live
  ON CONFLICT (challenge_sha256) DO NOTHING
  RETURNING 1
)
SELECT (SELECT live FROM deadline) AS live, EXISTS (SELECT 1 FROM spent) AS spent_now`;

	const deadlineStatement =
		"SELECT to_timestamp(floor(extract(epoch FROM now())) + $1::double precision) AS expires_at";

	return {
		async deadline() {
			const [row] = await options.driver.query<DeadlineRow>(deadlineStatement, [
				PROOF_OF_WORK_LIFETIME_IN_SECONDS,
			]);
			if (!(row?.expires_at instanceof Date)) {
				throw new TypeError("the driver must decode timestamptz into a Date");
			}
			return row.expires_at;
		},

		async spend(solution) {
			const challengeSha256 = new Uint8Array(
				await crypto.subtle.digest("SHA-256", utf8.encode(solution.challenge)),
			);
			const [row] = await options.driver.query<SpendRow>(spendStatement, [
				challengeSha256,
				solution.expiresAtInSeconds,
			]);
			if (row?.live !== true) {
				return "expired";
			}
			return row.spent_now === true ? "spent_now" : "spent_before";
		},
	};
}
