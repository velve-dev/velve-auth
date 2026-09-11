import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import type { Driver } from "../src/core/db/driver.js";
import { lockAccountRowStatement } from "../src/core/db/lock.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, TEST_ORIGIN, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema, readUserOwnedTables } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import {
	accountLockAudit,
	backendPidOf,
	cyclesAmong,
	deadlocksReportedTo,
	HeldDriver,
	waitUntilWaitingForALock,
} from "./lock-order-fixtures.js";

const PASSWORD = "correct-horse-battery-staple";
const REPLACEMENT = "a different password entirely";

type Handler = (request: Request) => Promise<Response>;

let schema: string;
let observer: TestConnection;
let firstConnection: TestConnection;
let secondConnection: TestConnection;
let held: HeldDriver;
let watched: HeldDriver;
let first: Handler;
let second: Handler;
let pidOfSecond: number;
let owned: Set<string>;
const outbox: EmailMessage[] = [];
/** One key ring for both handlers: a recovery code is stored as an HMAC under `token-pepper`, so two
 * providers would put the code beyond the reach of the request that redeems it. */
const keys = testKeyProvider();

function handlerOn(database: Driver): Handler {
	return toWebHandler(
		createVelveAuth(
			configFor({
				database,
				schema,
				keys,
				// The interleaving is the subject; a bucket that refuses the second request would
				// measure itself instead.
				rateLimit: {
					perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
					perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
				},
				email: {
					send: (message) => {
						outbox.push(message);
						return Promise.resolve();
					},
				},
			}),
		),
	);
}

beforeAll(async () => {
	const migrated = await openMigratedSchema("lockorder");
	schema = migrated.schema;
	observer = migrated.connection;
	firstConnection = await openTestConnection();
	secondConnection = await openTestConnection();
	held = new HeldDriver(firstConnection);
	watched = new HeldDriver(secondConnection);
	first = handlerOn(held);
	second = handlerOn(watched);
	pidOfSecond = await backendPidOf(secondConnection);
	owned = new Set((await readUserOwnedTables(observer, schema)).map((table) => table.table));
}, 120_000);

afterAll(async () => {
	await dropSchema(observer, schema);
	await Promise.all([observer.close(), firstConnection.close(), secondConnection.close()]);
});

function post(handler: Handler, path: string, body: unknown, cookie?: string): Promise<Response> {
	return handler(
		new Request(`https://api.example.com${path}`, {
			method: "POST",
			headers: {
				Origin: TEST_ORIGIN,
				"Content-Type": "application/json",
				...(cookie === undefined ? {} : { Cookie: cookie }),
			},
			body: JSON.stringify(body),
		}),
	);
}

function sessionCookieOf(answer: Response): string {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === DEFAULT_COOKIE_NAMES.session) {
			return pair;
		}
	}
	throw new Error("the answer carried no session cookie");
}

function tokenOf(kind: EmailMessage["kind"]): string {
	const message = outbox.filter((each) => each.kind === kind).at(-1);
	if (message === undefined || !("token" in message)) {
		throw new Error(`no ${kind} message carried a token`);
	}
	return message.token;
}

async function signUp(address: string): Promise<string> {
	const answer = await post(second, "/sign-up", { email: address, password: PASSWORD });
	if (answer.status !== 200) {
		throw new Error(`the sign-up answered ${answer.status}`);
	}
	return sessionCookieOf(answer);
}

/**
 * The interleaving both cycles need: the first request is stopped just before the statement that
 * reaches its second table, the second request is let run until the server reports it waiting for a
 * lock, and only then is the first released. Before the repair each pair reached `40P01` on 14.24
 * and on 18.3 (E-1601); the assertion is that neither does.
 *
 * `waitUntilWaitingForALock` raising rather than returning is what keeps the case from passing
 * vacuously: if the second request never waits for a lock, the two never overlapped and the case
 * fails instead of reporting no deadlock (E-1603).
 */
async function interleave(
	holdFirstBefore: RegExp,
	one: () => Promise<Response>,
	other: () => Promise<Response>,
): Promise<PromiseSettledResult<Response>[]> {
	held.forgetFailures();
	watched.forgetFailures();
	const reached = held.holdBefore(holdFirstBefore);
	const running = one();
	await reached;
	const concurrent = other();
	await waitUntilWaitingForALock(observer, pidOfSecond, () => watched.statements.join("\n"));
	held.release();
	return Promise.allSettled([running, concurrent]);
}

function statuses(outcomes: readonly PromiseSettledResult<Response>[]): (number | string)[] {
	return outcomes.map((outcome) =>
		outcome.status === "fulfilled" ? outcome.value.status : String(outcome.reason),
	);
}

describe("no interleaving of two account writes deadlocks (CLAUDE.md §7)", () => {
	it("confirms an address while a password reset completes on the same account", async () => {
		const address = "cycle-a@example.com";
		await signUp(address);
		await post(second, "/password/request-reset", { email: address });
		const verification = tokenOf("email_verification");
		const reset = tokenOf("password_reset");

		const outcomes = await interleave(
			new RegExp(`DELETE FROM ${schema}\\.session`),
			() => post(first, "/email/redeem-verification", { token: verification }),
			() => post(second, "/password/redeem-reset", { token: reset, newPassword: REPLACEMENT }),
		);

		expect(deadlocksReportedTo([held, watched])).toBe(0);
		expect(statuses(outcomes)).toEqual([200, 200]);
	}, 60_000);

	it("regenerates recovery codes while one of them is redeemed on the same account", async () => {
		const address = "cycle-b@example.com";
		const cookie = await signUp(address);
		const generated = await post(first, "/factor/recovery/generate", {}, cookie);
		const { codes } = (await generated.json()) as { codes: readonly string[] };
		expect(codes).toHaveLength(10);

		const outcomes = await interleave(
			new RegExp(`DELETE FROM ${schema}\\.recovery_code`),
			() => post(first, "/factor/recovery/generate", {}, cookie),
			() =>
				post(second, "/password/redeem-reset-with-recovery-code", {
					email: address,
					recoveryCode: codes[0] ?? "",
					newPassword: REPLACEMENT,
				}),
		);

		// The regeneration wins the account's row and replaces the set, so the code the redemption
		// carries is one of the ones it replaced: `invalid_recovery_code`, 401. Before the repair the
		// same interleaving answered 500 with `40P01` behind it.
		expect(deadlocksReportedTo([held, watched])).toBe(0);
		expect(statuses(outcomes)).toEqual([200, 401]);
	}, 60_000);

	/**
	 * The mode, pinned where it matters: with the account row held, an insert of a user-owned row for
	 * that account must not wait, because the `FOR KEY SHARE` its foreign key takes waits for
	 * `FOR UPDATE` and for nothing else (E-1604). `lock_timeout` turns a wait into a reported failure
	 * rather than a hung case, so the outcome is decided rather than timed out. It is the only case
	 * here that reddens when the mode is put back (E-1607).
	 */
	it("lets a foreign key's own lock through while the account row is held", async () => {
		const address = "cycle-c@example.com";
		await signUp(address);
		const [account] = await observer.query<{ id: string }>(
			`SELECT id FROM ${schema}.user WHERE email = $1`,
			[address],
		);
		let locked = (): void => {};
		let finish = (): void => {};
		const isLocked = new Promise<void>((resolve) => {
			locked = resolve;
		});
		const mayFinish = new Promise<void>((resolve) => {
			finish = resolve;
		});

		const holding = firstConnection.transaction(async (transaction) => {
			await transaction.query(lockAccountRowStatement(schema), [account?.id]);
			locked();
			await mayFinish;
		});
		await isLocked;

		await secondConnection.query("SET lock_timeout = '2000ms'", []);
		const outcome = await secondConnection
			.query(
				`INSERT INTO ${schema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at)
				 VALUES ($1, $2, now() + interval '1 hour', now() + interval '1 day') RETURNING id`,
				[account?.id, randomBytes(32)],
			)
			.then(() => "the insert went through")
			.catch((failure: unknown) => `the insert waited: ${String(failure)}`);
		await secondConnection.query("SET lock_timeout = 0", []);
		finish();
		await holding;

		expect(outcome).toBe("the insert went through");
	}, 60_000);

	/**
	 * The declared statement, not the ordering it happens to produce. Deleting `lockAccountRow` from
	 * `confirmAddress` leaves that transaction correctly ordered anyway — its own `UPDATE velve.user`
	 * takes the same mode on the same row — so a case reading the order stays green and the statement
	 * is unpinned. This reads the marker's position instead. Its reach is what it reports: of the
	 * **nine** transactions this file drives, three create the account and are excluded, four more
	 * write fewer than two of the account's own tables, and **two** are considered — the first
	 * confirmation and the reset redemption. Six of the eight lock sites are outside it, and three of
	 * those six can be deleted with the whole suite green (E-1617, E-1625).
	 */
	it("runs the declared account lock before the first of the account's own tables", () => {
		const { late, considered } = accountLockAudit(
			[...held.transactions, ...watched.transactions],
			schema,
			owned,
		);

		expect(late).toEqual([]);
		expect(considered).toBeGreaterThanOrEqual(2);
	});

	/**
	 * The classification of an `UPDATE` as `FOR NO KEY UPDATE` is true of this schema and not of SQL:
	 * `moveAddressStatement` writes `email`, which **is** a unique-index column, and the update stays at
	 * the weaker strength only because both unique indexes on the account table are partial and a
	 * partial index cannot be a foreign key's target. Planted both ways on 14.24 and 18.3: with a total
	 * index the same update blocks a child insert. Migration `0002_identity_email.sql` adds
	 * `CHECK (email IS NOT NULL)`, which makes the partial predicate redundant in email mode and
	 * invites removing it — so the property is asserted here rather than assumed (E-1618).
	 *
	 * It fails closed on an index it cannot read: a unique index over an **expression** has no column
	 * for the `attname` lookup, so a planted `lower(email)` index is reported as `user_lower_email on
	 * null` — the right answer for the wrong reason, and a message a reader cannot act on.
	 */
	it("changes an address without blocking a child insert, and says why", async () => {
		const indexes = await observer.query<{ name: string; columns: string; partial: boolean }>(
			`SELECT index_.relname AS name,
			        (SELECT string_agg(column_.attname, ',' ORDER BY column_.attname)
			           FROM pg_attribute column_
			          WHERE column_.attrelid = table_.oid AND column_.attnum = ANY (i.indkey)) AS columns,
			        (i.indpred IS NOT NULL) AS partial
			   FROM pg_index i
			   JOIN pg_class index_ ON index_.oid = i.indexrelid
			   JOIN pg_class table_ ON table_.oid = i.indrelid
			   JOIN pg_namespace namespace_ ON namespace_.oid = table_.relnamespace
			  WHERE namespace_.nspname = $1 AND table_.relname = 'user' AND i.indisunique`,
			[schema],
		);
		const totalOnAnythingButTheKey = indexes
			.filter((index) => !index.partial && index.columns !== "id")
			.map((index) => `${index.name} on ${index.columns}`);

		const address = "cycle-d@example.com";
		await signUp(address);
		const [account] = await observer.query<{ id: string }>(
			`SELECT id FROM ${schema}.user WHERE email = $1`,
			[address],
		);
		let changed = (): void => {};
		let finish = (): void => {};
		const isChanged = new Promise<void>((resolve) => {
			changed = resolve;
		});
		const mayFinish = new Promise<void>((resolve) => {
			finish = resolve;
		});

		const holding = firstConnection.transaction(async (transaction) => {
			await transaction.query(
				`UPDATE ${schema}.user SET email = $2, updated_at = now() WHERE id = $1`,
				[account?.id, "cycle-d-moved@example.com"],
			);
			changed();
			await mayFinish;
		});
		await isChanged;

		await secondConnection.query("SET lock_timeout = '2000ms'", []);
		const outcome = await secondConnection
			.query(
				`INSERT INTO ${schema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at)
				 VALUES ($1, $2, now() + interval '1 hour', now() + interval '1 day') RETURNING id`,
				[account?.id, randomBytes(32)],
			)
			.then(() => "the insert went through")
			.catch((failure: unknown) => `the insert waited: ${String(failure)}`);
		await secondConnection.query("SET lock_timeout = 0", []);
		finish();
		await holding;

		expect(indexes.length).toBeGreaterThan(2);
		expect(totalOnAnythingButTheKey).toEqual([]);
		expect(outcome).toBe("the insert went through");
	}, 60_000);

	/**
	 * The ordering, read off the statements the two cases above actually ran rather than inferred from
	 * the source: no two of them take two tables in opposite orders, in modes that wait for each
	 * other, without an earlier lock in common. It says nothing about transactions this file did not
	 * drive, which is why it reports how many it read.
	 */
	it("finds no pair of transactions that could wait for each other in a cycle", () => {
		const transactions = [...held.transactions, ...watched.transactions];
		const cycles = cyclesAmong(transactions, schema, owned);

		expect(cycles.map((cycle) => cycle.reported)).toEqual([]);
		expect(transactions.filter((statements) => statements.length > 1).length).toBeGreaterThan(6);
	});
});
