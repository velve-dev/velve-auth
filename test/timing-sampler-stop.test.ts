import { describe, expect, it } from "vitest";
import { sampleUntilResolved } from "./timing-fixtures.js";

const A_PLAN = {
	minimumPerGroup: 20,
	maximumPerGroup: 40,
	discardedWarmup: 0,
	blockPerGroup: 20,
	budgetMs: 60_000,
};

/** Cheap and roughly uniform, so the sampler's stopping rule is what decides, not the workload. */
async function anOperation(): Promise<void> {
	await Promise.resolve();
}

/**
 * A run that stops on its time budget has not been given the sample size it was permitted, so it
 * measured nothing about the code. `E-1883` found that reported as an unresolvable leak: a shared
 * runner took 4720 of 6000 permitted rounds in the 300 s the case allowed, and the case read the
 * resolution it happened to have as one that could not be reached.
 */
describe("the sampler says why it stopped (E-1883)", () => {
	it("says budget when the time ran out before the permitted sample size", async () => {
		const samples = await sampleUntilResolved(anOperation, {
			...A_PLAN,
			minimumPerGroup: 1_000_000,
			maximumPerGroup: 1_000_000,
			budgetMs: 0,
		});

		expect(samples.stoppedBecause).toBe("budget");
		expect(samples.roundsPerGroup).toBeLessThan(1_000_000);
	});

	/** A minimum above the maximum makes the resolved branch unreachable, so the loop can only
	 * leave by exhausting the sample size — which is a different answer from running out of time. */
	it("says maximum when the permitted sample size was reached", async () => {
		const samples = await sampleUntilResolved(anOperation, {
			...A_PLAN,
			minimumPerGroup: 10_000,
			maximumPerGroup: 40,
		});

		expect(samples.stoppedBecause).toBe("maximum");
		expect(samples.roundsPerGroup).toBeGreaterThanOrEqual(40);
	});

	it("distinguishes the two, which is the whole of what this buys", async () => {
		const outOfTime = await sampleUntilResolved(anOperation, {
			...A_PLAN,
			minimumPerGroup: 1_000_000,
			maximumPerGroup: 1_000_000,
			budgetMs: 0,
		});
		const outOfSamples = await sampleUntilResolved(anOperation, {
			...A_PLAN,
			minimumPerGroup: 10_000,
			maximumPerGroup: 40,
		});

		expect(outOfTime.stoppedBecause).not.toBe(outOfSamples.stoppedBecause);
	});
});
