import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MountedAuth, mountAuth } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import { drawTestPassword } from "./password-fixtures.js";
import {
	CLIFFS_DELTA_LIMIT,
	CONTROL_RECOVERY_TOLERANCE,
	cliffsDelta,
	DISCARDED_WARMUP,
	describeResolution,
	MAD_OUTLIER_FACTOR,
	MEASUREMENTS_PER_GROUP,
	mean,
	PLANTED_CONTROL_LEAK_NS,
	resolutionOf,
	sampleUntilResolved,
	type TimingArm,
	TRIM_FRACTION,
	trimmed,
	WELCH_T_LIMIT,
	WHAT_TO_TRY_BEFORE_LOOSENING_ANYTHING,
	welchT,
	withoutMadOutliers,
} from "./timing-fixtures.js";

//a password sign-in refused for a broken state costs what a wrong password costs (S-INTEG-5, T-INTEG-5)

const ACCOUNTS_PER_GROUP = 50;
const RESOLUTION_BUDGET_MS = 900_000;
const BLOCK_PER_GROUP = 250;
const MAXIMUM_PER_GROUP = 25_000;
const CASE_TIMEOUT_MS = 1_800_000;

const PASSWORD = drawTestPassword();
const WRONG_PASSWORD = drawTestPassword();

let mounted: MountedAuth;
const broken: string[] = [];
const intact: string[] = [];
let rounds = 0;

async function signedUp(email: string): Promise<string> {
	const answer = await mounted.handler(postTo("/sign-up", { email, password: PASSWORD }));
	expect(answer.status).toBe(200);
	return ((await answer.json()) as { user: { id: string } }).user.id;
}

beforeAll(async () => {
	if (process.env.VELVE_NIGHTLY !== "1") {
		return;
	}
	mounted = await mountAuth("broken_timing", {
		rateLimit: {
			perIpAddress: { capacity: 10_000_000, refillPerSecond: 10_000_000 },
			perAccount: { capacity: 10_000_000, refillPerSecond: 10_000_000 },
		},
	});
	for (let index = 0; index < ACCOUNTS_PER_GROUP; index += 1) {
		const brokenEmail = `broken-${index}@timing.example`;
		const userId = await signedUp(brokenEmail);
		await mounted.connection.query(
			`UPDATE ${mounted.schema}.security_state SET digest = $2 WHERE user_id = $1`,
			[userId, randomBytes(32)],
		);
		broken.push(brokenEmail);
		const intactEmail = `intact-${index}@timing.example`;
		await signedUp(intactEmail);
		intact.push(intactEmail);
	}
}, 600_000);

afterAll(async () => {
	if (process.env.VELVE_NIGHTLY !== "1") {
		return;
	}
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

//the present arm is a broken account with its right password, the absent arm an intact one with a wrong password
async function signInAttempt(arm: TimingArm): Promise<void> {
	rounds += 1;
	const index = rounds % ACCOUNTS_PER_GROUP;
	const attempt =
		arm === "present"
			? { email: broken[index], password: PASSWORD }
			: { email: arm === "absent" ? intact[index] : intact[0], password: WRONG_PASSWORD };
	const answer = await mounted.handler(postTo("/sign-in/password", attempt));
	await answer.arrayBuffer();
}

function alternating(samples: readonly number[]): [number[], number[]] {
	return [
		samples.filter((_, index) => index % 2 === 0),
		samples.filter((_, index) => index % 2 === 1),
	];
}

describe("T-INTEG-5: the broken-state refusal of a password sign-in is uniform under measurement", () => {
	it.skipIf(process.env.VELVE_NIGHTLY !== "1")(
		"separates a broken account from a wrong password by less than the dudect threshold",
		async () => {
			const samples = await sampleUntilResolved(signInAttempt, {
				minimumPerGroup: MEASUREMENTS_PER_GROUP,
				maximumPerGroup: MAXIMUM_PER_GROUP,
				discardedWarmup: DISCARDED_WARMUP,
				blockPerGroup: BLOCK_PER_GROUP,
				budgetMs: RESOLUTION_BUDGET_MS,
			});

			const present = trimmed(samples.present, TRIM_FRACTION);
			const absent = trimmed(samples.absent, TRIM_FRACTION);
			const reached = describeResolution(present, absent);
			const [quietLeft, quietRight] = alternating(samples.controlQuiet);
			const planted = trimmed(samples.controlPlanted, TRIM_FRACTION);
			const quiet = trimmed(samples.controlQuiet, TRIM_FRACTION);
			const recovered = mean(planted) - mean(quiet);

			expect(samples.roundsPerGroup).toBeGreaterThanOrEqual(MEASUREMENTS_PER_GROUP);
			expect(
				samples.stoppedBecause,
				`the budget ran out after ${Math.round(samples.elapsedMs / 1000)} s, so this run says nothing about the code`,
			).not.toBe("budget");
			expect(
				resolutionOf(present, absent).resolvesTheLeakThatMatters,
				`the run could not resolve the smallest leak 5.1 (a) names: ${reached}. ${WHAT_TO_TRY_BEFORE_LOOSENING_ANYTHING}`,
			).toBe(true);
			expect(
				Math.abs(welchT(trimmed(quietLeft, TRIM_FRACTION), trimmed(quietRight, TRIM_FRACTION))),
				"two samples of one operation separated: the runner is the fault, not the code",
			).toBeLessThan(WELCH_T_LIMIT);
			expect(Math.abs(welchT(planted, quiet))).toBeGreaterThan(WELCH_T_LIMIT);
			expect(Math.abs(recovered - PLANTED_CONTROL_LEAK_NS) / PLANTED_CONTROL_LEAK_NS).toBeLessThan(
				CONTROL_RECOVERY_TOLERANCE,
			);

			expect(
				Math.abs(welchT(present, absent)),
				`Welch t, ${reached}. ${WHAT_TO_TRY_BEFORE_LOOSENING_ANYTHING}`,
			).toBeLessThan(WELCH_T_LIMIT);
			expect(
				Math.abs(
					cliffsDelta(
						withoutMadOutliers(samples.present, MAD_OUTLIER_FACTOR),
						withoutMadOutliers(samples.absent, MAD_OUTLIER_FACTOR),
					),
				),
				`Cliff's delta, ${reached}. ${WHAT_TO_TRY_BEFORE_LOOSENING_ANYTHING}`,
			).toBeLessThan(CLIFFS_DELTA_LIMIT);
		},
		CASE_TIMEOUT_MS,
	);
});
