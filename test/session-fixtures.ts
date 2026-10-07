import { randomBytes } from "node:crypto";
import type { Driver } from "../src/core/db/driver.js";
import type { SessionInsert } from "../src/core/db/repositories/session.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { sessionBinding } from "../src/core/session/binding.js";
import { createSessionToken } from "../src/core/session/token.js";
import { bindToken } from "../src/core/token/binding.js";
import { testKeyProvider } from "./auth-fixtures.js";

const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The key a repository under test checks its rows with, and the one `sessionInsertFor` binds under. */
export const SESSION_FIXTURE_KEYS: KeyProvider = testKeyProvider();

/** A session insert whose MAC is taken under `SESSION_FIXTURE_KEYS`, as the session service takes it. */
export function sessionInsertFor(
	userId: string,
	overrides: Partial<SessionInsert> = {},
): SessionInsert {
	const insert = {
		userId,
		tokenHash: createSessionToken().tokenHash,
		factors: ["password"] as const,
		ipAddress: null,
		userAgent: null,
		idleTimeoutMs: 7 * DAY,
		absoluteTimeoutMs: 30 * DAY,
		...overrides,
	};
	return {
		bindUnder: (issue) =>
			bindToken(
				SESSION_FIXTURE_KEYS,
				sessionBinding(insert.userId, insert.tokenHash, insert.factors, issue),
			),
		...insert,
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
 * The three columns a session row written by hand needs to resolve, taken the way the session
 * service takes them (S-INTEG-9): pass them as the last three parameters of the insert, for
 * `token_mac`, `token_mac_key_version` and `created_at`, the last cast to `timestamptz`. An account
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
): Promise<[Uint8Array, number, string]> {
	const createdAt = new Date();
	const { tokenMac, tokenMacKeyVersion } = await bindToken(keys, {
		purpose: "session",
		ownerId: row.userId,
		tokenSha256: row.tokenHash,
		content: {
			factors: row.factors,
			sessionEpoch: row.sessionEpoch ?? 1,
			createdAtMicros: createdAt.getTime() * 1000,
		},
	});
	return [tokenMac, tokenMacKeyVersion, createdAt.toISOString()];
}

/**
 * Takes the MAC of every session row of an account again, over what the row now stores, under
 * `keys` and the epoch the account is at; a test that ages a session by moving its `created_at`
 * calls this afterwards, since the MAC binds the creation time (S-INTEG-9).
 */
export async function rebindSessionsOf(
	driver: Driver,
	schema: string,
	keys: KeyProvider,
	where: { readonly userId?: string; readonly sessionId?: string },
): Promise<void> {
	const rows = await driver.query<{
		id: string;
		user_id: string;
		token_sha256: Uint8Array;
		factor_names: string;
		session_epoch: string;
		created_at_us: string;
	}>(
		`SELECT s.id, s.user_id, s.token_sha256, array_to_json(s.factors)::text AS factor_names,
			COALESCE((SELECT session_epoch FROM ${schema}.security_state st WHERE st.user_id = s.user_id), 1)::text AS session_epoch,
			(extract(epoch FROM s.created_at) * 1000000)::bigint::text AS created_at_us
		 FROM ${schema}.session s WHERE s.user_id = $1 OR s.id = $2`,
		[where.userId ?? null, where.sessionId ?? null],
	);
	for (const row of rows) {
		const { tokenMac, tokenMacKeyVersion } = await bindToken(
			keys,
			sessionBinding(row.user_id, new Uint8Array(row.token_sha256), JSON.parse(row.factor_names), {
				sessionEpoch: Number(row.session_epoch),
				createdAtMicros: Number(row.created_at_us),
			}),
		);
		await driver.query(
			`UPDATE ${schema}.session SET token_mac = $2, token_mac_key_version = $3 WHERE id = $1`,
			[row.id, tokenMac, tokenMacKeyVersion],
		);
	}
}

const LARGEST_EPOCH = 2 ** 53 - 1;

/**
 * An epoch drawn the way section 3.18 draws one at every raise: uniformly from 1 … 2^53 − 1 and
 * different from the one given, so a test never relies on epochs rising or being near the version.
 */
export function aFreshEpochOtherThan(current: number | null = null): number {
	for (;;) {
		const bytes = randomBytes(8);
		const epoch = Number(bytes.readBigUInt64BE() % BigInt(LARGEST_EPOCH)) + 1;
		if (epoch !== current) {
			return epoch;
		}
	}
}

/** Raises an account's epoch as a mass revocation does: to a fresh random value, never by one. */
export async function raiseEpochOf(
	driver: Driver,
	schema: string,
	userId: string,
): Promise<number> {
	const [row] = await driver.query<{ epoch: string }>(
		`SELECT session_epoch::text AS epoch FROM ${schema}.security_state WHERE user_id = $1`,
		[userId],
	);
	const fresh = aFreshEpochOtherThan(row === undefined ? null : Number(row.epoch));
	await driver.query(`UPDATE ${schema}.security_state SET session_epoch = $2 WHERE user_id = $1`, [
		userId,
		fresh,
	]);
	return fresh;
}
