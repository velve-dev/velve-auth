import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import {
	createPendingAuthenticationService,
	createSecondFactorCompletion,
	type PendingAuthenticationService,
	type PendingToken,
	type SecondFactorCompletion,
} from "../src/core/factor/pending/index.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

let connection: TestConnection;
let schema: string;
let pending: PendingAuthenticationService;
let completion: SecondFactorCompletion;
let userId: string;

const OBSERVED = { ipAddress: null, userAgent: null };

/**
 * Far fewer than the fifty S-RACE-1 fixes for a one-time token, and the number was measured rather
 * than chosen. `token-race.test.ts` legitimately holds fifty of the hundred connections this server
 * allows for the whole of its file; adding a seventh concurrency file at twenty-four turned the
 * nightly run red in *that* file, while `main` without this one was green — the budget is shared
 * and cumulative, and the file that pays is whichever runs last. Eight is what
 * `token-review-reissue-concurrency` uses, it is genuine simultaneity across eight connections,
 * and it proves the same statement: exactly one completion gets through. The connections are also
 * opened inside the test and closed before it returns, so the peak lasts one test rather than the
 * file (E-358).
 */
const ATTEMPTS = 8;

beforeAll(async () => {
	const migrated = await openMigratedSchema("pendingrace");
	connection = migrated.connection;
	schema = migrated.schema;
	pending = createPendingAuthenticationService({ driver: connection, schema });
	completion = createSecondFactorCompletion({ driver: connection, schema });
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

beforeEach(async () => {
	userId = await createUser(connection, schema);
});

async function beginPending(): Promise<PendingToken> {
	const issued = await pending.begin({
		userId,
		factorsCompleted: ["password"],
		availableFactors: ["totp"],
	});
	return issued.token;
}

async function count(table: string): Promise<number> {
	const [row] = await connection.query<{ present: number }>(
		`SELECT count(*)::int AS present FROM ${schema}.${table} WHERE user_id = $1`,
		[userId],
	);
	return row?.present ?? -1;
}

describe("finishing a second factor (S-FIX-1, S-RACE-5)", () => {
	it("removes the pending row and inserts the session, and reports both factors", async () => {
		const token = await beginPending();

		const issued = await completion.complete({
			pendingToken: token,
			factor: "totp",
			observed: OBSERVED,
		});

		expect(await count("pending_authentication")).toBe(0);
		expect(await count("session")).toBe(1);
		expect(issued.session.factors).toStrictEqual(["password", "totp"]);
		expect(issued.token).toHaveLength(43);
	});

	/**
	 * S-RACE-5: a failure after the one step and before the other leaves neither effect. Without the
	 * transaction, the pending state would already be spent and no session would exist — the caller
	 * would be locked out of a sign-in they had completed.
	 */
	it("leaves the pending row untouched when the session cannot be written", async () => {
		const token = await beginPending();
		const refusing: Driver = {
			query: (sql, params) =>
				/INSERT INTO .*\.session/is.test(sql)
					? Promise.reject(new Error("the session could not be written"))
					: connection.query(sql, params),
			transaction: (run) =>
				connection.transaction((tx) => run({ ...refusing, transaction: tx.transaction })),
		};

		await expect(
			createSecondFactorCompletion({ driver: refusing, schema }).complete({
				pendingToken: token,
				factor: "totp",
				observed: OBSERVED,
			}),
		).rejects.toThrow();

		expect(await count("session")).toBe(0);
		expect(await count("pending_authentication")).toBe(1);
		expect(await pending.resolve(token)).not.toBeNull();
	});

	it("lets exactly one of eight concurrent completions through", async () => {
		const token = await beginPending();
		// One connection per racer: a shared one serialises the statements and joins the transactions,
		// so every racer would run inside the first one's and one failure would roll back them all.
		const racers: TestConnection[] = [];
		for (let opened = 0; opened < ATTEMPTS; opened += 1) {
			racers.push(await openTestConnection());
		}

		try {
			const outcomes = await Promise.allSettled(
				racers.map((racer) =>
					createSecondFactorCompletion({ driver: racer, schema }).complete({
						pendingToken: token,
						factor: "totp",
						observed: OBSERVED,
					}),
				),
			);

			expect(racers).toHaveLength(ATTEMPTS);
			expect(new Set(racers).size).toBe(ATTEMPTS);
			expect(outcomes).toHaveLength(ATTEMPTS);
			expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
			expect(await count("session")).toBe(1);
			expect(await count("pending_authentication")).toBe(0);
		} finally {
			await Promise.all(racers.map((racer) => racer.close()));
		}
	});
});
