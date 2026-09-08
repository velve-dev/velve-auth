import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createKdfSemaphore,
	DEFAULT_WAIT_LIMIT_IN_MILLISECONDS,
} from "../src/core/password/semaphore.js";

function deferred(): { promise: Promise<void>; settle: () => void } {
	let settle = (): void => undefined;
	const promise = new Promise<void>((resolve) => {
		settle = resolve;
	});
	return { promise, settle };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("the KDF semaphore", () => {
	it("runs no more than the configured number of derivations at once", async () => {
		const semaphore = createKdfSemaphore({ limit: 4 });
		const gate = deferred();
		let observedPeak = 0;

		const runs = Array.from({ length: 200 }, () =>
			semaphore.run(async () => {
				observedPeak = Math.max(observedPeak, semaphore.inFlight);
				await gate.promise;
			}),
		);

		await Promise.resolve();
		gate.settle();
		await Promise.all(runs);

		expect(observedPeak).toBeLessThanOrEqual(4);
		expect(semaphore.peakInFlight).toBe(4);
		expect(semaphore.inFlight).toBe(0);
		expect(semaphore.waiting).toBe(0);
	});

	it("hands a freed place to the request that waited longest", async () => {
		const semaphore = createKdfSemaphore({ limit: 1 });
		const gates = [deferred(), deferred(), deferred()];
		const order: number[] = [];

		const runs = gates.map((gate, index) =>
			semaphore.run(async () => {
				order.push(index);
				await gate.promise;
			}),
		);

		for (const gate of gates) {
			await Promise.resolve();
			gate.settle();
			await Promise.resolve();
		}
		await Promise.all(runs);

		expect(order).toEqual([0, 1, 2]);
	});

	it("frees the place even when the work throws", async () => {
		const semaphore = createKdfSemaphore({ limit: 1 });

		await expect(
			semaphore.run(async () => {
				throw new Error("derivation failed");
			}),
		).rejects.toThrow("derivation failed");

		expect(semaphore.inFlight).toBe(0);
		await expect(semaphore.run(async () => "next")).resolves.toBe("next");
	});

	it("refuses a request that has waited five seconds", async () => {
		vi.useFakeTimers();
		const semaphore = createKdfSemaphore({ limit: 1 });
		const gate = deferred();

		const held = semaphore.run(() => gate.promise);
		const queued = semaphore.run(async () => "never reached");
		const outcome = queued.then(
			() => "granted",
			(failure: unknown) => (failure as { code: string }).code,
		);

		await vi.advanceTimersByTimeAsync(DEFAULT_WAIT_LIMIT_IN_MILLISECONDS - 1);
		expect(semaphore.waiting).toBe(1);

		await vi.advanceTimersByTimeAsync(1);

		expect(await outcome).toBe("rate_limited");
		expect(semaphore.waiting).toBe(0);

		gate.settle();
		await held;
	});

	it("answers a refused request faster than a granted one, with no derivation of its own", async () => {
		vi.useFakeTimers();
		const semaphore = createKdfSemaphore({ limit: 1, waitLimitInMilliseconds: 20 });
		const gate = deferred();
		let derivations = 0;

		const held = semaphore.run(async () => {
			derivations += 1;
			await gate.promise;
		});
		const refused = semaphore
			.run(async () => {
				derivations += 1;
			})
			.catch((failure: unknown) => failure);

		await vi.advanceTimersByTimeAsync(20);

		expect(await refused).toMatchObject({ code: "rate_limited", httpStatus: 429 });
		expect(derivations).toBe(1);

		gate.settle();
		await held;
	});

	it("leaves no timer behind when the place is granted before the limit", async () => {
		vi.useFakeTimers();
		const semaphore = createKdfSemaphore({ limit: 1 });
		const gate = deferred();

		const held = semaphore.run(() => gate.promise);
		const queued = semaphore.run(async () => "granted");

		await vi.advanceTimersByTimeAsync(1);
		gate.settle();

		expect(await queued).toBe("granted");
		expect(vi.getTimerCount()).toBe(0);
		await held;
	});

	it("settles every request under a flood and leaves nothing running", async () => {
		vi.useFakeTimers();
		const semaphore = createKdfSemaphore({ limit: 1, waitLimitInMilliseconds: 50 });
		const gate = deferred();

		const outcomes = Promise.allSettled(
			Array.from({ length: 500 }, () => semaphore.run(() => gate.promise)),
		);

		await vi.advanceTimersByTimeAsync(50);
		gate.settle();
		const settled = await outcomes;

		expect(settled).toHaveLength(500);
		expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
		for (const entry of settled) {
			if (entry.status === "rejected") {
				expect(entry.reason).toMatchObject({ code: "rate_limited" });
			}
		}
		expect(semaphore.inFlight).toBe(0);
		expect(semaphore.waiting).toBe(0);
	});
});
