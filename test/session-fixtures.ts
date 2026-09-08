import { type Actor, actorOfResolvedSession, type ResolvedSession } from "../src/core/db/actor.js";
import type { Driver } from "../src/core/db/driver.js";
import type { SessionInsert } from "../src/core/db/repositories/session.js";
import { createSessionToken } from "../src/core/session/token.js";

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * In the library only session resolution produces a `ResolvedSession` (E-93). A test that needs an
 * actor for a user it created itself asserts that here, in one place, and says so.
 */
export function actorOfTestUser(userId: string): Actor {
	return actorOfResolvedSession({ userId } as ResolvedSession);
}

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
