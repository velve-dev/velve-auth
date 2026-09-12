/**
 * Architecture 6.20 decides a timing case on `|Welch t| < 4.5`, and variance sits in Welch's
 * denominator: a noisy runner shrinks `|t|`, so a real leak passes and a run that could not look
 * is indistinguishable from a run that found nothing (E-1149, E-693).
 */

export const WELCH_T_LIMIT = 4.5;
export const CLIFFS_DELTA_LIMIT = 0.147;
export const TRIM_FRACTION = 0.1;
export const MAD_OUTLIER_FACTOR = 3;

/**
 * Architecture 5.1 (a) names three leak magnitudes: a sub-nanosecond early-exit comparison only an
 * in-process attacker uses, data-dependent database paths at 0.1 to 2 ms, and an early return at
 * 50 to 250 ms. 0.1 ms is the smallest a wall clock is asked to see; the sub-nanosecond class is
 * held by S-TIM-3 statically and by no measurement in this repository.
 */
const RESOLVABLE_LEAK_NS = 100_000;

/**
 * A reviewer meeting a red timing case reaches for the threshold first, and 6.20 point 4 forbids
 * that move in as many words. This rides on every message a reader of a red actually sees, because
 * the reasoning for it lives in `E-1540` and `E-1549` and a reason nobody reaches protects nothing.
 */
export const WHAT_TO_TRY_BEFORE_LOOSENING_ANYTHING = [
	"neither 4.5 nor 0.147 was moved to build this case and 6.20 point 4 forbids moving them now",
	"what changed is how many measurements are taken before they are read",
	"before reading this as a leak, run it from a clone outside every directory a file-sync daemon watches",
	"the same commit passed three times there and gave one pass, one red and one refusal inside one",
].join("; ");

/** 6.1 and 6.20 fix 1000 per group; the sampler treats it as the floor it is, never as the total. */
export const MEASUREMENTS_PER_GROUP = 1000;
export const DISCARDED_WARMUP = 100;

const CONTROL_EVERY_ROUNDS = 10;
const BATCHES = 20;
const MINIMUM_BATCH = 30;

/**
 * Ten times the leak that matters. The control arms take one sample every `CONTROL_EVERY_ROUNDS`
 * rounds while the case arms take one every round, so under the stopping rule below the smallest
 * leak the control itself can separate settles at
 * `RESOLVABLE_LEAK_NS * sqrt(CONTROL_EVERY_ROUNDS / 2)` — 223 607 ns — on any machine, because the
 * sample count and the dispersion move together. Computed exactly at every reachable round count it
 * runs from 212 132 ns to 223 159 ns, so this plant sits between 4.481 and 4.714 times above it
 * (E-1534, E-1548, E-1551).
 */
export const PLANTED_CONTROL_LEAK_NS = 1_000_000;

/** The recovered plant is checked against a band rather than against an exact value (E-1534). */
export const CONTROL_RECOVERY_TOLERANCE = 0.5;

export type TimingArm = "present" | "absent" | "controlQuiet" | "controlPlanted";

/**
 * Why the sampler stopped, which the numbers alone do not say. A run that ran out of time before
 * it reached the sample size it was permitted has not measured anything about the code — it is a
 * statement about the machine — and reporting that as an unresolvable leak is what a release
 * blocked on this case then reads as a finding (E-1883).
 */
export type SamplingStopped = "resolved" | "budget" | "maximum";

interface TimingSamples {
	readonly present: number[];
	readonly absent: number[];
	readonly controlQuiet: number[];
	readonly controlPlanted: number[];
	readonly roundsPerGroup: number;
	readonly elapsedMs: number;
	readonly stoppedBecause: SamplingStopped;
}

interface TimingPlan {
	readonly minimumPerGroup: number;
	readonly maximumPerGroup: number;
	readonly discardedWarmup: number;
	readonly blockPerGroup: number;
	readonly budgetMs: number;
}

function sortedAscending(samples: readonly number[]): number[] {
	return [...samples].sort((left, right) => left - right);
}

export function trimmed(samples: readonly number[], fraction: number): number[] {
	const sorted = sortedAscending(samples);
	const cut = Math.floor(sorted.length * fraction);
	return sorted.slice(cut, sorted.length - cut);
}

export function mean(samples: readonly number[]): number {
	return samples.reduce((total, value) => total + value, 0) / samples.length;
}

function variance(samples: readonly number[]): number {
	const centre = mean(samples);
	return samples.reduce((total, value) => total + (value - centre) ** 2, 0) / (samples.length - 1);
}

export function median(samples: readonly number[]): number {
	const sorted = sortedAscending(samples);
	return sorted[Math.floor(sorted.length / 2)] as number;
}

export function withoutMadOutliers(samples: readonly number[], factor: number): number[] {
	const centre = median(samples);
	const deviation = median(samples.map((value) => Math.abs(value - centre)));
	const bound = deviation * factor;

	return bound === 0 ? [...samples] : samples.filter((value) => Math.abs(value - centre) <= bound);
}

function standardError(left: readonly number[], right: readonly number[]): number {
	return Math.sqrt(variance(left) / left.length + variance(right) / right.length);
}

export function welchT(left: readonly number[], right: readonly number[]): number {
	const spread = standardError(left, right);
	return spread === 0 ? 0 : (mean(left) - mean(right)) / spread;
}

export function cliffsDelta(left: readonly number[], right: readonly number[]): number {
	const sorted = sortedAscending(right);
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

interface Resolution {
	/**
	 * The smallest true difference this run separates at 6.20's own threshold: a difference of
	 * exactly this size drives `|Welch t|` to 4.5 in expectation. It is read off the same trimmed
	 * samples the case decides on, so it reports what the case could have seen.
	 */
	readonly separableDifferenceNs: number;
	readonly resolvesTheLeakThatMatters: boolean;
}

export function resolutionOf(left: readonly number[], right: readonly number[]): Resolution {
	const separable = WELCH_T_LIMIT * standardError(left, right);

	return {
		separableDifferenceNs: separable,
		resolvesTheLeakThatMatters: separable <= RESOLVABLE_LEAK_NS,
	};
}

/**
 * What the second threshold resolves, from the samples the second threshold is read on — which are
 * not the samples the first is read on, and reporting one from the other describes a statistic
 * nobody computes (E-1536). Cliff's delta compares overlap rather than means, so it does not
 * sharpen with the sample size and no stopping rule moves this number: it is fixed by the
 * dispersion of a single measurement. The value is the small-delta normal approximation
 * `delta * sqrt(pi) * sd`. Against the size at which Cliff's delta actually reaches its threshold,
 * measured by bisection on three sample sets from one machine, it ran 8.7 per cent optimistic once
 * and 7.1 and 39.8 per cent pessimistic twice, so it is reported rather than asserted (E-1535).
 */
export function overlapResolutionNs(left: readonly number[], right: readonly number[]): number {
	return (
		CLIFFS_DELTA_LIMIT * Math.sqrt(Math.PI) * Math.sqrt((variance(left) + variance(right)) / 2)
	);
}

/**
 * The same resolution figure without the independence assumption `resolutionOf` inherits from
 * 6.20's statistic: the run is cut into batches in the order it was measured, and the spread of the
 * per-batch differences is what the standard error is taken from. Measured against three sample
 * sets it came out 1.26 to 2.60 times the independent estimate depending on the batch count, and
 * 2.40 and 3.04 times it on a second machine, so the samples carry time correlation and the figure
 * beside it is optimistic by about that much (E-1542, E-1551). Reported, never asserted — 6.1 fixes
 * the statistic that decides.
 */
export function correlatedResolutionNs(
	orderedLeft: readonly number[],
	orderedRight: readonly number[],
): number {
	const size = Math.floor(Math.min(orderedLeft.length, orderedRight.length) / BATCHES);
	if (size < MINIMUM_BATCH) {
		return Number.NaN;
	}
	const differences = Array.from({ length: BATCHES }, (_, index) => {
		const from = index * size;
		const left = trimmed(orderedLeft.slice(from, from + size), TRIM_FRACTION);
		const right = trimmed(orderedRight.slice(from, from + size), TRIM_FRACTION);
		return mean(left) - mean(right);
	});
	return WELCH_T_LIMIT * Math.sqrt(variance(differences) / BATCHES);
}

export function describeResolution(left: readonly number[], right: readonly number[]): string {
	const resolution = resolutionOf(left, right);
	return [
		`${left.length} and ${right.length} samples`,
		`separating ${Math.round(resolution.separableDifferenceNs)} ns`,
		`against the ${RESOLVABLE_LEAK_NS} ns that matters`,
	].join(", ");
}

/** A busy wait rather than a timer, so the plant is charged inside the region the case measures. */
function spinFor(nanoseconds: number): void {
	const end = process.hrtime.bigint() + BigInt(nanoseconds);
	let now = process.hrtime.bigint();
	while (now < end) {
		now = process.hrtime.bigint();
	}
}

function shuffledRound(size: number): number[] {
	const order = Array.from({ length: size * 2 }, (_, index) => index % 2);
	for (let index = order.length - 1; index > 0; index -= 1) {
		const swap = Math.floor(Math.random() * (index + 1));
		[order[index], order[swap]] = [order[swap] as number, order[index] as number];
	}
	return order;
}

interface Collected {
	readonly present: number[];
	readonly absent: number[];
	readonly controlQuiet: number[];
	readonly controlPlanted: number[];
	seenPresent: number;
	seenAbsent: number;
}

async function measureArm(run: (arm: TimingArm) => Promise<void>, arm: TimingArm): Promise<number> {
	const started = process.hrtime.bigint();
	await run(arm);
	if (arm === "controlPlanted") {
		spinFor(PLANTED_CONTROL_LEAK_NS);
	}
	return Number(process.hrtime.bigint() - started);
}

async function collectBlock(
	run: (arm: TimingArm) => Promise<void>,
	into: Collected,
	plan: TimingPlan,
): Promise<void> {
	for (const group of shuffledRound(plan.blockPerGroup)) {
		const present = group === 0;
		const elapsed = await measureArm(run, present ? "present" : "absent");
		const seen = present ? into.seenPresent : into.seenAbsent;
		if (seen >= plan.discardedWarmup) {
			(present ? into.present : into.absent).push(elapsed);
		}
		if (present) {
			into.seenPresent += 1;
		} else {
			into.seenAbsent += 1;
		}

		if ((into.seenPresent + into.seenAbsent) % CONTROL_EVERY_ROUNDS === 0) {
			into.controlQuiet.push(await measureArm(run, "controlQuiet"));
			into.controlPlanted.push(await measureArm(run, "controlPlanted"));
		}
	}
}

/**
 * Grows the sample until the run separates `RESOLVABLE_LEAK_NS`, and stops the moment it does. The
 * stopping rule reads the dispersion of the two groups and never their difference, so it does not
 * select for the outcome the case then decides — under normality the sample mean and the sample
 * variance are independent, and that is the assumption it rests on (E-1533).
 */
export async function sampleUntilResolved(
	run: (arm: TimingArm) => Promise<void>,
	plan: TimingPlan,
): Promise<TimingSamples> {
	const collected: Collected = {
		present: [],
		absent: [],
		controlQuiet: [],
		controlPlanted: [],
		seenPresent: 0,
		seenAbsent: 0,
	};
	const startedAt = Date.now();
	let stoppedBecause: SamplingStopped = "maximum";

	while (collected.seenPresent < plan.maximumPerGroup) {
		await collectBlock(run, collected, plan);

		const resolved = resolutionOf(
			trimmed(collected.present, TRIM_FRACTION),
			trimmed(collected.absent, TRIM_FRACTION),
		).resolvesTheLeakThatMatters;
		if (collected.seenPresent >= plan.minimumPerGroup && resolved) {
			stoppedBecause = "resolved";
			break;
		}
		if (Date.now() - startedAt >= plan.budgetMs) {
			stoppedBecause = "budget";
			break;
		}
	}

	return {
		present: collected.present,
		absent: collected.absent,
		controlQuiet: collected.controlQuiet,
		controlPlanted: collected.controlPlanted,
		roundsPerGroup: collected.seenPresent,
		elapsedMs: Date.now() - startedAt,
		stoppedBecause,
	};
}
