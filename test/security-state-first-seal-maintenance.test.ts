import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockAccountRowStatement } from "../src/core/db/lock.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

// T-INTEG-8, last row: a change and the maintenance step's first seal on one unsealed account.
// Section 3.18 *Sealing* runs both at READ COMMITTED under the account lock and reads the seal row
// after the lock, so the later of the two waits for the lock, reads the seal the earlier committed
// and updates it; nothing is retried (E-3297). The case runs that protocol, retrying only on 23505
// within the three attempts the specification keeps for a seal row created without the lock, and
// holds 0 retries and one seal row. The control runs the same protocol at REPEATABLE READ, the rule
// E-3280 abandoned, where the later one reads no seal row, fails on the primary key and needs the
// retry the old threshold of T-INTEG-8 counted. The change is seen waiting on the lock before the
// maintenance step commits.

let maintenance: TestConnection;
let change: TestConnection;
let observer: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("first_seal_maintenance");
	maintenance = migrated.connection;
	schema = migrated.schema;
	change = await openTestConnection();
	observer = await openTestConnection();
});

afterAll(async () => {
	await dropSchema(maintenance, schema);
	await maintenance.close();
	await change.close();
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
	throw new Error("the change never waited on the account lock");
}

async function sealOnce(connection: TestConnection, userId: string): Promise<void> {
	const [state] = await connection.query<{ version: string }>(
		`SELECT version::text AS version FROM ${schema}.security_state WHERE user_id = $1`,
		[userId],
	);
	if (state === undefined) {
		await connection.query(
			`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
			 VALUES ($1, 1, decode(repeat('00', 32), 'hex'), 1)`,
			[userId],
		);
		return;
	}
	await connection.query(`UPDATE ${schema}.security_state SET version = $2 WHERE user_id = $1`, [
		userId,
		Number(state.version) + 1,
	]);
}

async function changeWithRetries(
	userId: string,
	isolation: string,
	lockedFirst: Promise<void>,
): Promise<number> {
	let retries = 0;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		await change.query(`BEGIN ISOLATION LEVEL ${isolation}`, []);
		try {
			const locking = change.query(lockAccountRowStatement(schema), [userId]);
			if (attempt === 1) {
				await lockedFirst;
			}
			await locking;
			await sealOnce(change, userId);
			await change.query("COMMIT", []);
			return retries;
		} catch (error) {
			await change.query("ROLLBACK", []).catch(() => undefined);
			if ((error as { sqlState?: string }).sqlState !== "23505") {
				throw error;
			}
			retries += 1;
		}
	}
	throw new Error("three attempts were refused");
}

async function changeRacingTheFirstSeal(isolation: string) {
	const userId = await createUser(maintenance, schema);
	const changeBackend = await backendOf(change);
	await maintenance.query(`BEGIN ISOLATION LEVEL ${isolation}`, []);
	await maintenance.query(lockAccountRowStatement(schema), [userId]);
	await sealOnce(maintenance, userId);
	let release: () => void = () => undefined;
	const lockedFirst = new Promise<void>((resolve) => {
		release = resolve;
	});
	const running = changeWithRetries(userId, isolation, lockedFirst);
	await untilWaiting(changeBackend);
	await maintenance.query("COMMIT", []);
	release();
	const retries = await running;
	const [rows] = await observer.query<{ n: number; version: string }>(
		`SELECT count(*)::int AS n, max(version)::text AS version FROM ${schema}.security_state
		 WHERE user_id = $1`,
		[userId],
	);
	return { retries, sealRows: rows?.n, version: rows?.version };
}

describe("premise: T-INTEG-8: a change and the maintenance step's first seal on one unsealed account", () => {
	it("at READ COMMITTED the change waits for the lock, reads the first seal and is not retried", async () => {
		expect(await changeRacingTheFirstSeal("READ COMMITTED")).toStrictEqual({
			retries: 0,
			sealRows: 1,
			version: "2",
		});
	});

	it("control: at REPEATABLE READ the change reads no seal row and needs one retry", async () => {
		expect(await changeRacingTheFirstSeal("REPEATABLE READ")).toStrictEqual({
			retries: 1,
			sealRows: 1,
			version: "2",
		});
	});
});
