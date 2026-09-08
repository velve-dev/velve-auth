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

// Architecture 6.1 and 6.20: 1000 measurements per group, interleaved in random order, the first
// 100 discarded, production KDF parameters, decided on |Welch t| < 4.5 and Cliff's delta < 0.147.
// 6.20 point 5 puts T-TIM-1 in the nightly stage rather than in the commit stage, because a shared
// runner is the commonest cause of a false alarm; the deterministic counterpart is
// `password-uniformity.test.ts`, which does block every commit.
const MEASUREMENTS_PER_GROUP = 1000;
const DISCARDED_WARMUP = 100;
const WELCH_T_LIMIT = 4.5;
const CLIFFS_DELTA_LIMIT = 0.147;
const ACCOUNTS_PER_GROUP = 50;
const PRODUCTION_ARGON2ID = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;

const PASSWORD = drawTestPassword();
const ATTEMPTED_PASSWORD = drawTestPassword();

let migrated: MigratedSchema;
let environment: PasswordEnvironment;
let presentUserIds: string[] = [];

function trimmed(samples: readonly number[], fraction: number): number[] {
	const sorted = [...samples].sort((left, right) => left - right);
	const cut = Math.floor(sorted.length * fraction);
	return sorted.slice(cut, sorted.length - cut);
}

function withoutMadOutliers(samples: readonly number[], factor: number): number[] {
	const sorted = [...samples].sort((left, right) => left - right);
	const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
	const deviations = sorted
		.map((value) => Math.abs(value - median))
		.sort((left, right) => left - right);
	const mad = deviations[Math.floor(deviations.length / 2)] ?? 0;
	const bound = mad * factor;

	return bound === 0 ? [...samples] : samples.filter((value) => Math.abs(value - median) <= bound);
}

function mean(samples: readonly number[]): number {
	return samples.reduce((total, value) => total + value, 0) / samples.length;
}

function variance(samples: readonly number[]): number {
	const centre = mean(samples);
	return samples.reduce((total, value) => total + (value - centre) ** 2, 0) / (samples.length - 1);
}

function welchT(left: readonly number[], right: readonly number[]): number {
	const spread = variance(left) / left.length + variance(right) / right.length;
	return spread === 0 ? 0 : (mean(left) - mean(right)) / Math.sqrt(spread);
}

function cliffsDelta(left: readonly number[], right: readonly number[]): number {
	const sorted = [...right].sort((a, b) => a - b);
	let dominance = 0;

	for (const value of left) {
		let low = 0;
		let high = sorted.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if ((sorted[middle] as number) < value) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}
		let upper = low;
		while (upper < sorted.length && sorted[upper] === value) {
			upper += 1;
		}
		dominance += low - (sorted.length - upper);
	}

	return dominance / (left.length * sorted.length);
}

async function measure(userId: string | null): Promise<number> {
	const started = process.hrtime.bigint();
	await checkPassword({ userId, plaintext: ATTEMPTED_PASSWORD }, environment).catch(
		() => undefined,
	);
	return Number(process.hrtime.bigint() - started);
}

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
		await credentials.write({ userId, phc, scheme: "argon2id" });
		presentUserIds.push(userId);
	}
}, 600_000);

afterAll(async () => {
	presentUserIds = [];
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

interface Samples {
	readonly present: number[];
	readonly absent: number[];
	readonly calibrationLeft: number[];
	readonly calibrationRight: number[];
}

/** Interleaved in random order, because measuring all of X then all of Y measures cache warming. */
function interleavedOrder(): number[] {
	const order = Array.from({ length: MEASUREMENTS_PER_GROUP * 2 }, (_, index) => index % 2);
	for (let index = order.length - 1; index > 0; index -= 1) {
		const swap = Math.floor(Math.random() * (index + 1));
		[order[index], order[swap]] = [order[swap] as number, order[index] as number];
	}
	return order;
}

async function collectSamples(): Promise<Samples> {
	const samples: Samples = { present: [], absent: [], calibrationLeft: [], calibrationRight: [] };
	const counted = { present: 0, absent: 0 };

	for (const group of interleavedOrder()) {
		const present = group === 0;
		const identifier = present
			? (presentUserIds[counted.present % ACCOUNTS_PER_GROUP] as string)
			: null;
		const elapsed = await measure(identifier);
		const seen = present ? counted.present : counted.absent;

		if (seen >= DISCARDED_WARMUP) {
			(present ? samples.present : samples.absent).push(elapsed);
		}
		if (present) {
			counted.present += 1;
		} else {
			counted.absent += 1;
		}

		// The calibration pair is two runs of the same operation measured in the same loop, so that
		// machine drift shows up in a number the test can read off (6.20). It is sampled rather than
		// taken every round, because a full third pass would double the run.
		if ((counted.present + counted.absent) % 5 === 0) {
			samples.calibrationLeft.push(await measure(presentUserIds[0] as string));
			samples.calibrationRight.push(await measure(presentUserIds[0] as string));
		}
	}

	return samples;
}

describe("T-TIM-1 — the sign-in path is uniform under measurement", () => {
	it.skipIf(process.env.VELVE_NIGHTLY !== "1")(
		"separates a present from an absent identifier by less than the dudect threshold",
		async () => {
			const samples = await collectSamples();

			const t = welchT(trimmed(samples.present, 0.1), trimmed(samples.absent, 0.1));
			const delta = cliffsDelta(
				withoutMadOutliers(samples.present, 3),
				withoutMadOutliers(samples.absent, 3),
			);
			const calibration = welchT(
				trimmed(samples.calibrationLeft, 0.1),
				trimmed(samples.calibrationRight, 0.1),
			);

			expect(samples.present.length).toBe(MEASUREMENTS_PER_GROUP - DISCARDED_WARMUP);
			expect(samples.absent.length).toBe(MEASUREMENTS_PER_GROUP - DISCARDED_WARMUP);
			expect(
				Math.abs(calibration),
				"the calibration pair itself broke the threshold: the runner is the fault, not the code",
			).toBeLessThan(WELCH_T_LIMIT);
			expect(Math.abs(t), "Welch t on 10 per cent trimmed means").toBeLessThan(WELCH_T_LIMIT);
			expect(Math.abs(delta), "Cliff's delta").toBeLessThan(CLIFFS_DELTA_LIMIT);
		},
		1_800_000,
	);
});
