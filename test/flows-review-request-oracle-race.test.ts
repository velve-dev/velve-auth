import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { VelveAuthConfig } from "../src/core/auth/config.js";
import type { Driver } from "../src/core/db/driver.js";
import {
	createOneTimeTokenRepository,
	OneTimeTokenError,
} from "../src/core/db/repositories/token.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createOneTimeTokens } from "../src/core/token/one-time-token.js";
import { createVelveAuth } from "../src/index.js";
import { TEST_ORIGIN, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { postTo } from "./flows-fixtures.js";

const KNOWN = "held.account@example.com";
const UNKNOWN = "absent.account@example.com";
/** A second unknown address, so the control compares two branches that are the same branch. */
const ALSO_UNKNOWN = "missing.person@example.com";
const PASSWORD = "correct horse battery staple";

/** Enough requests that a lock held for the length of one is held across the rest of the batch. */
const CONTENDING_CONNECTIONS = 30;
/** Fifteen rounds left the closed side reaching 1.48 against a limit the open side crossed at 1.52. */
const ROUNDS = 30;

/** Long enough that an uncontended request finishes inside it by two orders of magnitude. */
const WHILE_THE_ROW_IS_HELD_MS = 750;

/**
 * How far apart the two branches may be, and how far apart the control may be before the run has
 * measured nothing. Ten runs on 2026-09-09 against a local PostgreSQL 18.3: with the row lock in
 * place the case separated 1.48, 1.66, 1.82, 1.85 and 1.88; with the subject lock, 1.06, 1.06,
 * 1.09, 1.18 and 1.20. Controls ranged 1.00 to 1.25 on both. What is left on the closed side is
 * work rather than waiting — the known branch supersedes a row where the cover branch supersedes
 * nothing (E-941), and its insert takes the foreign key's share lock where the cover's does not
 * (E-932). The statistic is the low percentile of the per-round medians and not their median,
 * for the reason E-946 records.
 */
const SEPARATION_LIMIT = 1.35;

/**
 * The control is two unknown addresses against each other, so what it shows is the machine and not
 * the branches. A run whose control is outside the limit cannot tell the two apart either way and
 * is repeated rather than passed: a measurement that concluded nothing must not read as a
 * measurement that found nothing (CLAUDE.md §5). A run where none of the attempts settles fails.
 */
const ATTEMPTS = 5;

let connections: TestConnection[] = [];
let handlers: ((request: Request) => Promise<Response>)[] = [];
let bystander: TestConnection;
let onlooker: TestConnection;
let schema = "";
let victim = "";

function handlerOn(connection: TestConnection) {
	return toWebHandler(
		createVelveAuth({
			identity: { mode: "email" },
			database: connection,
			schema,
			keys: testKeyProvider(),
			origins: [TEST_ORIGIN],
			rateLimit: {
				perIpAddress: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
				perAccount: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
			},
			email: { send: () => Promise.resolve() },
		} as VelveAuthConfig<"email">),
	);
}

beforeAll(async () => {
	const migrated = await openMigratedSchema("requestoracle");
	schema = migrated.schema;
	connections = [migrated.connection];
	while (connections.length < CONTENDING_CONNECTIONS) {
		connections.push(await openTestConnection());
	}
	handlers = connections.map(handlerOn);
	bystander = await openTestConnection();
	onlooker = await openTestConnection();
	await (handlers[0] as (request: Request) => Promise<Response>)(
		postTo("/sign-up", { email: KNOWN, password: PASSWORD }),
	);
	const [account] = await bystander.query<{ id: string }>(
		`SELECT id FROM ${schema}.user WHERE email = $1`,
		[KNOWN],
	);
	victim = account?.id ?? "";
}, 120_000);

afterAll(async () => {
	const [first] = connections;
	if (first !== undefined) {
		await dropSchema(first, schema);
	}
	await Promise.all([...connections, bystander, onlooker].map((connection) => connection.close()));
});

function settling<T>(work: Promise<T>): { readonly done: () => boolean } {
	let settled = false;
	void work.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	return { done: () => settled };
}

function waitFor(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** The strongest lock any path in `src/` takes on `velve.user`, and the one every write of a
 * user-owned row already tolerates, because a foreign key takes `FOR KEY SHARE` and the two do not
 * conflict. */
const LIBRARY_STRENGTH = "FOR NO KEY UPDATE";

async function heldOverTheProbe(strength: string, probe: () => Promise<void>): Promise<void> {
	let releaseTheRow = (): void => undefined;
	const holding = bystander.transaction(async (transaction) => {
		await transaction.query(
			`SELECT id FROM ${schema}.user WHERE id = $1 ${strength} /* locks: ${schema}.user */`,
			[victim],
		);
		await new Promise<void>((resolve) => {
			releaseTheRow = resolve;
		});
	});
	await waitFor(WHILE_THE_ROW_IS_HELD_MS);
	try {
		await probe();
	} finally {
		releaseTheRow();
		await holding;
		await waitFor(WHILE_THE_ROW_IS_HELD_MS);
	}
}

function requesting(handler: number, address: string): { readonly done: () => boolean } {
	return settling(
		(handlers[handler] as (request: Request) => Promise<Response>)(
			postTo("/password/request-reset", { email: address }),
		),
	);
}

/**
 * 5.3 (a) names the response time as an oracle to close, and the two request rows of 3.13 exist to
 * have no branch a caller can see. A lock the request takes on the account's row is such a branch:
 * the statement text is the same either way, but a known address locks a row somebody else can hold
 * and an unknown one matches nothing and locks nothing. S-TIM-6 is met to the letter while this
 * stands, because the query sequence is identical (E-931).
 */
describe("a request for a known address takes no lock of its own on that account's row", () => {
	it("answers both addresses while a bystander holds the row as strongly as the library ever does", async () => {
		let answeredWhileHeld: boolean[] = [];
		await heldOverTheProbe(LIBRARY_STRENGTH, async () => {
			const onKnown = requesting(0, KNOWN);
			const onUnknown = requesting(1, UNKNOWN);
			await waitFor(WHILE_THE_ROW_IS_HELD_MS);
			answeredWhileHeld = [onKnown.done(), onUnknown.done()];
		});

		expect(answeredWhileHeld, "known and unknown, while the victim's row was held").toStrictEqual([
			true,
			true,
		]);
	}, 120_000);

	/**
	 * The control the case needs to be worth anything: a plain write of the same row does wait for
	 * that same lock over that same interval, so the expectation above measures whether the request
	 * takes a lock and not whether the probe can see one at all.
	 */
	it("blocks a plain write of that row over the same interval", async () => {
		let finishedWhileHeld = true;
		let writing: { readonly done: () => boolean } = { done: () => false };
		await heldOverTheProbe(LIBRARY_STRENGTH, async () => {
			writing = settling(
				onlooker.query(`UPDATE ${schema}.user SET updated_at = now() WHERE id = $1`, [victim]),
			);
			await waitFor(WHILE_THE_ROW_IS_HELD_MS);
			finishedWhileHeld = writing.done();
		});

		expect(finishedWhileHeld).toBe(false);
		expect(writing.done()).toBe(true);
	}, 120_000);

	/**
	 * What is left, pinned rather than closed. `FOR UPDATE` conflicts with the `FOR KEY SHARE` a
	 * foreign key takes on the row it references, so a request that writes a row owned by the
	 * account waits for it and a request that writes the cover row of E-597 does not. That is the
	 * schema and not this feature: the second half of the case runs the bare inserts and shows the
	 * same split with no library code between them. Nothing in `src/` holds `FOR UPDATE` on
	 * `velve.user` without a session behind it, which is the whole of what bounds this (E-932).
	 */
	it("still splits under FOR UPDATE, and the bare inserts split the same way", async () => {
		let answeredWhileHeld: boolean[] = [];
		let insertedWhileHeld: boolean[] = [];
		await heldOverTheProbe("FOR UPDATE", async () => {
			const onKnown = requesting(0, KNOWN);
			const onUnknown = requesting(1, UNKNOWN);
			const owned = settling(
				onlooker.query(
					`INSERT INTO ${schema}.one_time_token (token_sha256, purpose, user_id, expires_at)
					 VALUES ($1, 'magic_link', $2, now() + interval '1 hour')`,
					[Buffer.alloc(32, 1), victim],
				),
			);
			const ownerless = settling(
				(connections[2] as TestConnection).query(
					`INSERT INTO ${schema}.one_time_token (token_sha256, purpose, user_id, expires_at)
					 VALUES ($1, 'magic_link', NULL, now() + interval '1 hour')`,
					[Buffer.alloc(32, 2)],
				),
			);
			await waitFor(WHILE_THE_ROW_IS_HELD_MS);
			answeredWhileHeld = [onKnown.done(), onUnknown.done()];
			insertedWhileHeld = [owned.done(), ownerless.done()];
		});

		expect(answeredWhileHeld, "known and unknown under FOR UPDATE").toStrictEqual([false, true]);
		expect(insertedWhileHeld, "an owned insert and an ownerless one").toStrictEqual([false, true]);
	}, 120_000);
});

function median(samples: readonly number[]): number {
	const sorted = [...samples].sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)] as number;
}

/** How far apart two medians are, whichever of them is the larger. */
function separation(left: number, right: number): number {
	return Math.max(left / right, right / left);
}

async function batchFor(address: string): Promise<number[]> {
	let release = (): void => undefined;
	const gate = new Promise<void>((resolve) => {
		release = () => resolve();
	});
	const timed = handlers.map((handler) =>
		gate.then(async () => {
			const started = process.hrtime.bigint();
			await handler(postTo("/password/request-reset", { email: address }));
			return Number(process.hrtime.bigint() - started) / 1e6;
		}),
	);
	release();
	return Promise.all(timed);
}

/**
 * The same oracle without a bystander. Requests about one account serialise on that account's row
 * while it exists and run in parallel while it does not, so the attacker supplies their own
 * contention and reads the answer off the batch — no privileged position, and the separation grows
 * with the batch size (E-931).
 */
interface Measurement {
	readonly caseSeparation: number;
	readonly controlSeparation: number;
	readonly report: string;
}

async function measureTheTwoBranches(): Promise<Measurement> {
	const knownRounds: number[] = [];
	const unknownRounds: number[] = [];
	const controlRounds: number[] = [];
	const perRound: string[] = [];
	for (let round = 0; round < ROUNDS; round += 1) {
		const known = median(await batchFor(KNOWN));
		const unknown = median(await batchFor(UNKNOWN));
		const control = median(await batchFor(ALSO_UNKNOWN));
		knownRounds.push(known);
		unknownRounds.push(unknown);
		controlRounds.push(control);
		perRound.push(`${known.toFixed(1)}/${unknown.toFixed(1)}/${control.toFixed(1)}`);
	}
	// A stall can only make a round slower, so the quickest rounds of each group are the ones no
	// stall reached and the low percentile of each group is what the group costs when nothing else
	// is happening. Comparing the medians instead lets a stall that hit one group and not another
	// decide the answer, which on a busy machine it does.
	const quiet = (rounds: readonly number[]): number =>
		[...rounds].sort((left, right) => left - right)[Math.floor(rounds.length * 0.1)] as number;
	const caseSeparation = separation(quiet(knownRounds), quiet(unknownRounds));
	const controlSeparation = separation(quiet(unknownRounds), quiet(controlRounds));
	return {
		caseSeparation,
		controlSeparation,
		report:
			`case ${caseSeparation.toFixed(2)}, control ${controlSeparation.toFixed(2)}, ` +
			`known/unknown/control ms per round ${perRound.join(" ")}`,
	};
}

describe("a batch of requests contends the same whether or not the address names an account", () => {
	it("separates the two addresses no further than the limit a tight control admits", async () => {
		const attempts: Measurement[] = [];
		while (attempts.length < ATTEMPTS) {
			const measured = await measureTheTwoBranches();
			attempts.push(measured);
			if (measured.controlSeparation < SEPARATION_LIMIT) {
				expect(measured.caseSeparation, `known against unknown: ${measured.report}`).toBeLessThan(
					SEPARATION_LIMIT,
				);
				return;
			}
		}
		expect(
			attempts.map((attempt) => attempt.controlSeparation),
			`no attempt was quiet enough to measure: ${attempts.map((attempt) => attempt.report).join(" | ")}`,
		).toStrictEqual([]);
	}, 300_000);
});

/**
 * What the row lock used to guarantee and the subject lock does not: nothing holds the account's
 * row between the read that finds it and the insert that references it. E-263 took the lock so that
 * a foreign-key violation could not reach the caller as a driver error naming the table and the
 * constraint; the violation is now possible and is translated where it lands (E-931).
 */
function deletingTheOwnerAfterTheRead(driver: Driver, userId: string): Driver {
	const wrap = (inner: Driver): Driver => ({
		query<T>(sql: string, params: unknown[]): Promise<T[]> {
			return inner.query<T>(sql, params).then(async (rows) => {
				if (sql.includes("pg_advisory_xact_lock")) {
					await onlooker.query(`DELETE FROM ${schema}.user WHERE id = $1`, [userId]);
				}
				return rows;
			});
		},
		transaction: (run) => inner.transaction((tx) => run(wrap(tx))),
	});
	return wrap(driver);
}

describe("an account that goes between the read and the insert", () => {
	it("is refused with a code and not with the driver's own error", async () => {
		const doomed = "doomed.account@example.com";
		await (handlers[0] as (request: Request) => Promise<Response>)(
			postTo("/sign-up", { email: doomed, password: PASSWORD }),
		);
		const [account] = await onlooker.query<{ id: string }>(
			`SELECT id FROM ${schema}.user WHERE email = $1`,
			[doomed],
		);
		const userId = account?.id ?? "";

		const raised = (await createOneTimeTokens(
			createOneTimeTokenRepository({
				driver: deletingTheOwnerAfterTheRead(connections[3] as TestConnection, userId),
				schema,
			}),
		)
			.issue({ purpose: "password_reset", userId })
			.then(() => null)
			.catch((failure: unknown) => failure)) as OneTimeTokenError;

		expect(raised).toBeInstanceOf(OneTimeTokenError);
		expect(raised.code).toBe("one_time_token_owner_unknown");
		expect(`${raised.message} ${raised.stack ?? ""}`).not.toContain("one_time_token");
	}, 120_000);
});
