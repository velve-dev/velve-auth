import type { Driver } from "../src/core/db/driver.js";
import type { SessionInsert } from "../src/core/db/repositories/session.js";
import { createSessionToken } from "../src/core/session/token.js";

const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function sessionInsertFor(
	userId: string,
	overrides: Partial<SessionInsert> = {},
): SessionInsert {
	return {
		userId,
		tokenHash: createSessionToken().tokenHash,
		factors: ["password"],
		ipAddress: null,
		userAgent: null,
		idleTimeoutMs: 7 * DAY,
		absoluteTimeoutMs: 30 * DAY,
		...overrides,
	};
}

export interface CountedDriver {
	readonly driver: Driver;
	readonly statements: readonly string[];
	reset(): void;
}

export function countingDriver(inner: Driver): CountedDriver {
	const statements: string[] = [];
	const driver: Driver = {
		query(sql, params) {
			statements.push(sql);
			return inner.query(sql, params);
		},
		transaction: (fn) => inner.transaction((tx) => fn(countedTransaction(tx, statements))),
	};
	return {
		driver,
		get statements() {
			return statements;
		},
		reset: () => {
			statements.length = 0;
		},
	};
}

function countedTransaction(inner: Driver, statements: string[]): Driver {
	return {
		query(sql, params) {
			statements.push(sql);
			return inner.query(sql, params);
		},
		transaction: (fn) => inner.transaction((tx) => fn(countedTransaction(tx, statements))),
	};
}

export function statementsMatching(driver: CountedDriver, pattern: RegExp): readonly string[] {
	return driver.statements.filter((sql) => pattern.test(sql));
}

/**
 * The session service takes no clock, so a process-clock skew can only be introduced where the
 * process reads one: `new Date()` and `Date.now()`. A parsing call keeps its argument, so the
 * driver still decodes what the database sent.
 */
export async function withProcessClockShiftedBy<T>(
	offsetMs: number,
	run: () => Promise<T>,
): Promise<T> {
	const realDate = globalThis.Date;
	globalThis.Date = new Proxy(realDate, {
		construct: (target, parameters) =>
			parameters.length === 0
				? Reflect.construct(target, [realDate.now() + offsetMs])
				: Reflect.construct(target, parameters),
		get: (target, property, receiver) =>
			property === "now"
				? () => realDate.now() + offsetMs
				: Reflect.get(target, property, receiver),
	});
	try {
		return await run();
	} finally {
		globalThis.Date = realDate;
	}
}
