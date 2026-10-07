import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockAccountRowStatement } from "../src/core/db/lock.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

// Section 3.18 point 5 rebinds token MACs outside the account-lock transaction, row by row with a
// compare-and-set, because CLAUDE.md section 7 orders one_time_token before velve.user and a
// redemption consumes its row before it reaches lockAccountRow. The case holds that rule against
// PostgreSQL: a rebind that does not hold the account lock waits for the redemption and then finds
// the row gone. The control holds why: a rebind under the account lock deadlocks with it (E-3281).

let redeemer: TestConnection;
let maintainer: TestConnection;
let observer: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("maintenance_token_order");
	redeemer = migrated.connection;
	schema = migrated.schema;
	maintainer = await openTestConnection();
	observer = await openTestConnection();
});

afterAll(async () => {
	await dropSchema(redeemer, schema);
	await redeemer.close();
	await maintainer.close();
	await observer.close();
});

async function backendOf(connection: TestConnection): Promise<number> {
	const [row] = await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid", []);
	return row?.pid ?? -1;
}

async function untilWaiting(waiter: number): Promise<void> {
	for (let poll = 0; poll < 300; poll += 1) {
		const [row] = await observer.query<{ n: number }>(
			"SELECT cardinality(pg_blocking_pids($1::int))::int AS n",
			[waiter],
		);
		if ((row?.n ?? 0) > 0) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("the transaction never waited");
}

function outcome(work: Promise<unknown>): Promise<string> {
	return work.then(
		() => "done",
		(error: { sqlState?: string; code?: string }) => error.sqlState ?? error.code ?? "error",
	);
}

async function redemptionAgainstARebind(rebindUnderTheAccountLock: boolean): Promise<string[]> {
	const userId = await createUser(redeemer, schema);
	const tokenHash = new Uint8Array(32).fill(rebindUnderTheAccountLock ? 7 : 8);
	await redeemer.query(
		`INSERT INTO ${schema}.one_time_token (token_sha256, purpose, user_id, expires_at)
		 VALUES ($1, 'password_reset', $2, now() + interval '1 hour')`,
		[tokenHash, userId],
	);
	const redeemerBackend = await backendOf(redeemer);
	const maintainerBackend = await backendOf(maintainer);

	await redeemer.query("BEGIN", []);
	await maintainer.query("BEGIN", []);
	try {
		await redeemer.query(
			`DELETE FROM ${schema}.one_time_token WHERE token_sha256 = $1 RETURNING user_id`,
			[tokenHash],
		);
		if (rebindUnderTheAccountLock) {
			await maintainer.query(lockAccountRowStatement(schema), [userId]);
		}
		const rebinding = outcome(
			maintainer.query(
				`UPDATE ${schema}.one_time_token SET payload = payload
				 WHERE token_sha256 = $1 RETURNING token_sha256`,
				[tokenHash],
			),
		);
		await untilWaiting(maintainerBackend);
		const locking = outcome(
			redeemer
				.query(lockAccountRowStatement(schema), [userId])
				.then(() => redeemer.query("COMMIT", [])),
		);
		await untilWaiting(redeemerBackend).catch(() => undefined);
		return await Promise.all([locking, rebinding]);
	} finally {
		await redeemer.query("ROLLBACK", []).catch(() => undefined);
		await maintainer.query("ROLLBACK", []).catch(() => undefined);
	}
}

describe("premise: a token MAC rebind and a redemption that consumes first and locks second", () => {
	it("outside the account lock waits for the redemption and deadlocks with nothing", async () => {
		expect(await redemptionAgainstARebind(false)).toStrictEqual(["done", "done"]);
	});

	it("control: under the account lock deadlocks with it", async () => {
		expect(await redemptionAgainstARebind(true)).toContain("40P01");
	});
});
