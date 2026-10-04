/**
 * What every key derivation below the library has asked for while it ran. A test wraps the KDF
 * functions of `@noble/hashes`, `hash-wasm` and `bcryptjs` with `accounted` inside its `vi.mock`
 * factories, so a derivation the semaphore never saw is counted as well.
 */
interface KdfAccounting {
	calls: number;
	inFlight: number;
	peakInFlight: number;
	inFlightKiB: number;
	peakInFlightKiB: number;
	readonly memoryRequestsKiB: number[];
	reset(): void;
}

export const kdfAccounting: KdfAccounting = {
	calls: 0,
	inFlight: 0,
	peakInFlight: 0,
	inFlightKiB: 0,
	peakInFlightKiB: 0,
	memoryRequestsKiB: [],
	reset() {
		this.calls = 0;
		this.peakInFlight = this.inFlight;
		this.peakInFlightKiB = this.inFlightKiB;
		this.memoryRequestsKiB.length = 0;
	},
};

export function accounted<A extends unknown[], R>(
	derive: (...args: A) => Promise<R>,
	memoryKiBOf: (...args: A) => number,
): (...args: A) => Promise<R> {
	return (...args: A): Promise<R> => {
		const memoryKiB = memoryKiBOf(...args);
		kdfAccounting.calls += 1;
		kdfAccounting.inFlight += 1;
		kdfAccounting.inFlightKiB += memoryKiB;
		kdfAccounting.memoryRequestsKiB.push(memoryKiB);
		kdfAccounting.peakInFlight = Math.max(kdfAccounting.peakInFlight, kdfAccounting.inFlight);
		kdfAccounting.peakInFlightKiB = Math.max(
			kdfAccounting.peakInFlightKiB,
			kdfAccounting.inFlightKiB,
		);
		return derive(...args).finally(() => {
			kdfAccounting.inFlight -= 1;
			kdfAccounting.inFlightKiB -= memoryKiB;
		});
	};
}
