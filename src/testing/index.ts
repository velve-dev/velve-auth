import type { Clock } from "../core/http/environment.js";

/**
 * Architecture 6.19: every expiry, window and TOTP test needs a deterministic time, and the core
 * reads the time only through `clock` and through `now()` in the database. This is the `clock` a
 * test hands to the configuration.
 */
export interface TestClock extends Clock {
	set(instant: Date): void;
	advanceBy(milliseconds: number): void;
}

const DEFAULT_START = "2026-01-01T00:00:00.000Z";

export function createTestClock(start: Date = new Date(DEFAULT_START)): TestClock {
	let instant = new Date(start.getTime());
	return {
		now: () => new Date(instant.getTime()),
		set: (next) => {
			instant = new Date(next.getTime());
		},
		advanceBy: (milliseconds) => {
			instant = new Date(instant.getTime() + milliseconds);
		},
	};
}
