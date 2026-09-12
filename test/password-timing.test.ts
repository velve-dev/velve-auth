import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rootKeyProvider } from "../src/core/keys/index.js";
import { resolvePasswordConfig } from "../src/core/password/config.js";
import { createPasswordCredentialRepository } from "../src/core/password/credential.js";
import { createKdfSemaphore } from "../src/core/password/semaphore.js";
import {
	checkPassword,
	createDummyCredential,
	type PasswordEnvironment,
} from "../src/core/password/verify.js";
import { dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { generateRootKey } from "./keys-fixtures.js";
import { drawTestPassword } from "./password-fixtures.js";
import {
	CLIFFS_DELTA_LIMIT,
	CONTROL_RECOVERY_TOLERANCE,
	cliffsDelta,
	correlatedResolutionNs,
	DISCARDED_WARMUP,
	describeResolution,
	MAD_OUTLIER_FACTOR,
	MEASUREMENTS_PER_GROUP,
	mean,
	overlapResolutionNs,
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

// Architecture 6.1 and 6.20: interleaved in random order, production KDF parameters, the first 100
// measurements of each group discarded, decided on |Welch t| < 4.5 and Cliff's delta < 0.147.
// 6.20 point 5 puts T-TIM-1 in the nightly stage; the deterministic counterpart is
// `password-uniformity.test.ts`, which blocks every commit.
const PRODUCTION_ARGON2ID = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const ACCOUNTS_PER_GROUP = 50;

/**
 * 6.20 quotes Trail of Bits on runs longer than five minutes, because more measurements raise the
 * detection probability. The sampler spends up to this long buying the resolution the case needs
 * and reports what it reached; the timeout below leaves room for the block it is inside when the
 * budget expires (E-1533).
 */
const RESOLUTION_BUDGET_MS = 900_000;
const BLOCK_PER_GROUP = 250;
const MAXIMUM_PER_GROUP = 25_000;
const CASE_TIMEOUT_MS = 1_800_000;

const PASSWORD = drawTestPassword();
const ATTEMPTED_PASSWORD = drawTestPassword();

let migrated: MigratedSchema;
let environment: PasswordEnvironment;
let presentUserIds: string[] = [];
let presentCount = 0;

beforeAll(async () => {
	migrated = await openMigratedSchema("password_timing");
	const keys = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });
	const config = resolvePasswordConfig({ argon2id: PRODUCTION_ARGON2ID });
	const credentials = createPasswordCredentialRepository({
		driver: migrated.connection,
		keys,
		schema: migrated.schema,
	});

	environment = {
		config,
		keys,
		credentials,
		semaphore: createKdfSemaphore({ limit: config.concurrentHashLimit }),
		dummy: await createDummyCredential(keys, config),
	};

	const { createArgon2idHash } = await import("../src/core/password/argon2.js");
	const phc = await createArgon2idHash(new TextEncoder().encode(PASSWORD), PRODUCTION_ARGON2ID);

	for (let index = 0; index < ACCOUNTS_PER_GROUP; index += 1) {
		const [row] = await migrated.connection.query<{ id: string }>(
			`INSERT INTO ${migrated.schema}.user (email) VALUES ($1) RETURNING id`,
			[`present-${index}@timing.example`],
		);
		const userId = (row as { id: string }).id;
		await credentials.write({ userId, phc, scheme: "argon2id", setBySessionId: null });
		presentUserIds.push(userId);
	}
}, 600_000);

afterAll(async () => {
	presentUserIds = [];
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

/** Both control arms run the operation the present group runs, against one fixed account. */
function identifierFor(arm: TimingArm): string | null {
	if (arm === "absent") {
		return null;
	}
	if (arm === "present") {
		presentCount += 1;
		return presentUserIds[presentCount % ACCOUNTS_PER_GROUP] as string;
	}
	return presentUserIds[0] as string;
}

async function signInAttempt(arm: TimingArm): Promise<void> {
	await checkPassword(
		{ userId: identifierFor(arm), plaintext: ATTEMPTED_PASSWORD },
		environment,
	).catch(() => undefined);
}

/** Two samples of one operation, drawn alternately, so a runner manufacturing a gap shows one. */
function alternating(samples: readonly number[]): [number[], number[]] {
	return [
		samples.filter((_, index) => index % 2 === 0),
		samples.filter((_, index) => index % 2 === 1),
	];
}

describe("T-TIM-1 — the sign-in path is uniform under measurement", () => {
	it.skipIf(process.env.VELVE_NIGHTLY !== "1")(
		"separates a present from an absent identifier by less than the dudect threshold",
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
			const resolution = resolutionOf(present, absent);
			const reached = `${describeResolution(present, absent)}, and ${Math.round(correlatedResolutionNs(samples.present, samples.absent))} ns once the batches are allowed to be correlated`;

			const [quietLeft, quietRight] = alternating(samples.controlQuiet);
			const planted = trimmed(samples.controlPlanted, TRIM_FRACTION);
			const quiet = trimmed(samples.controlQuiet, TRIM_FRACTION);
			const recovered = mean(planted) - mean(quiet);

			expect(
				samples.roundsPerGroup,
				`the budget ran out before 6.1's own sample size was reached, after ${Math.round(samples.elapsedMs / 1000)} s`,
			).toBeGreaterThanOrEqual(MEASUREMENTS_PER_GROUP);
			// A run that stopped on its time budget has not been given the sample size it was
			// permitted, so it measured nothing about the code and the resolution below bounds
			// nothing either. Reported as what it is before anything is read off it (E-1883).
			expect(
				samples.stoppedBecause,
				`the budget ran out at ${samples.roundsPerGroup} of ${MAXIMUM_PER_GROUP} permitted rounds after ${Math.round(samples.elapsedMs / 1000)} s, so this run says nothing about the code — the machine was too slow to take the measurements the case declares, and the numbers it did take bound nothing`,
			).not.toBe("budget");
			expect(
				resolution.resolvesTheLeakThatMatters,
				`the run could not resolve the smallest leak 5.1 (a) names, so it reports neither a leak nor its absence: ${reached}, after ${samples.roundsPerGroup} rounds and ${Math.round(samples.elapsedMs / 1000)} s. ${WHAT_TO_TRY_BEFORE_LOOSENING_ANYTHING}`,
			).toBe(true);
			expect(
				Math.abs(welchT(trimmed(quietLeft, TRIM_FRACTION), trimmed(quietRight, TRIM_FRACTION))),
				"two samples of one operation separated: the runner is the fault, not the code",
			).toBeLessThan(WELCH_T_LIMIT);
			expect(
				Math.abs(welchT(planted, quiet)),
				`the run did not see a planted ${PLANTED_CONTROL_LEAK_NS} ns leak, so it cannot report that there is none: ${reached}`,
			).toBeGreaterThan(WELCH_T_LIMIT);
			expect(
				Math.abs(recovered - PLANTED_CONTROL_LEAK_NS) / PLANTED_CONTROL_LEAK_NS,
				`the planted leak was measured as ${Math.round(recovered)} ns, so the measurement is not on the scale it reports`,
			).toBeLessThan(CONTROL_RECOVERY_TOLERANCE);

			expect(
				Math.abs(welchT(present, absent)),
				`Welch t, ${reached}. ${WHAT_TO_TRY_BEFORE_LOOSENING_ANYTHING}`,
			).toBeLessThan(WELCH_T_LIMIT);
			const overlapPresent = withoutMadOutliers(samples.present, MAD_OUTLIER_FACTOR);
			const overlapAbsent = withoutMadOutliers(samples.absent, MAD_OUTLIER_FACTOR);
			expect(
				Math.abs(cliffsDelta(overlapPresent, overlapAbsent)),
				`Cliff's delta, which no sample size sharpens and which separates about ${Math.round(overlapResolutionNs(overlapPresent, overlapAbsent))} ns here: ${reached}. ${WHAT_TO_TRY_BEFORE_LOOSENING_ANYTHING}`,
			).toBeLessThan(CLIFFS_DELTA_LIMIT);
		},
		CASE_TIMEOUT_MS,
	);
});
