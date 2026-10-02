import { VelveError } from "../http/error-map.js";

//the wait limit is a resource limit and refuses alike for a real and an absent account (E-14)
export const DEFAULT_WAIT_LIMIT_IN_MILLISECONDS = 5000;

export interface KdfSemaphoreOptions {
	readonly limit: number;
	readonly waitLimitInMilliseconds?: number;
}

export interface KdfSemaphore {
	run<T>(work: () => Promise<T>): Promise<T>;
	readonly inFlight: number;
	readonly peakInFlight: number;
	readonly waiting: number;
}

interface Waiter {
	readonly grant: () => void;
	readonly refuse: (failure: Error) => void;
	timer: ReturnType<typeof setTimeout> | undefined;
}

//a sign-in flood is refused rather than exhausting memory one Argon2 hash at a time (S-DOS-3)
export function createKdfSemaphore(options: KdfSemaphoreOptions): KdfSemaphore {
	const waitLimitInMilliseconds =
		options.waitLimitInMilliseconds ?? DEFAULT_WAIT_LIMIT_IN_MILLISECONDS;
	const waiting: Waiter[] = [];
	let inFlight = 0;
	let peakInFlight = 0;

	function enter(): void {
		inFlight += 1;
		peakInFlight = Math.max(peakInFlight, inFlight);
	}

	function leave(): void {
		inFlight -= 1;

		const next = waiting.shift();
		if (next !== undefined) {
			clearTimeout(next.timer);
			enter();
			next.grant();
		}
	}

	function acquire(): Promise<void> {
		if (inFlight < options.limit) {
			enter();
			return Promise.resolve();
		}

		return new Promise<void>((resolve, reject) => {
			const waiter: Waiter = { grant: resolve, refuse: reject, timer: undefined };

			waiter.timer = setTimeout(() => {
				const queued = waiting.indexOf(waiter);
				if (queued !== -1) {
					waiting.splice(queued, 1);
				}
				//waiting past the limit is a refusal and never a memory error (S-DOS-4)
				waiter.refuse(new VelveError("rate_limited"));
			}, waitLimitInMilliseconds);

			waiting.push(waiter);
		});
	}

	return {
		async run<T>(work: () => Promise<T>): Promise<T> {
			await acquire();
			try {
				return await work();
			} finally {
				leave();
			}
		},
		get inFlight() {
			return inFlight;
		},
		get peakInFlight() {
			return peakInFlight;
		},
		get waiting() {
			return waiting.length;
		},
	};
}
