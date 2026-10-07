import type { Driver } from "../src/core/db/driver.js";
import type { SessionInsert } from "../src/core/db/repositories/session.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { createSessionToken } from "../src/core/session/token.js";
import { bindToken } from "../src/core/token/binding.js";

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
		bindUnderEpoch: () => Promise.resolve({ tokenMac: new Uint8Array(32), tokenMacKeyVersion: 1 }),
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

/**
 * The two MAC columns a session row written by hand needs to resolve, taken the way the session
 * service takes them (S-INTEG-9): pass them as the last two parameters of the insert. An account
 * without a seal row is at epoch 1.
 */
export async function sessionMacParameters(
	keys: KeyProvider,
	row: {
		readonly userId: string;
		readonly tokenHash: Uint8Array;
		readonly factors: readonly string[];
		readonly sessionEpoch?: number;
	},
): Promise<[Uint8Array, number]> {
	const { tokenMac, tokenMacKeyVersion } = await bindToken(keys, {
		purpose: "session",
		ownerId: row.userId,
		tokenSha256: row.tokenHash,
		content: { factors: row.factors, sessionEpoch: row.sessionEpoch ?? 1 },
	});
	return [tokenMac, tokenMacKeyVersion];
}
