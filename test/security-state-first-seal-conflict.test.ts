import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockAccountRowStatement } from "../src/core/db/lock.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

//two first seals of one account meet without a unique violation at read committed (E-3288)

let first: TestConnection;
let second: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("first_seal_conflict");
	first = migrated.connection;
	schema = migrated.schema;
	second = await openTestConnection();
});

afterAll(async () => {
	await dropSchema(first, schema);
	await first.close();
	await second.close();
});

function sealInsert(connection: TestConnection, userId: string): Promise<unknown> {
	return connection.query(
		`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
		 VALUES ($1, 1, decode(repeat('00', 32), 'hex'), 1)`,
		[userId],
	);
}

async function backendOf(connection: TestConnection): Promise<number> {
	const [row] = await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid", []);
	return row?.pid ?? -1;
}

async function untilWaiting(observer: TestConnection, waiter: number): Promise<void> {
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
	throw new Error("the second transaction never waited on the account lock");
}

async function secondFirstSealAfterWaiting(isolation: string) {
	const userId = await createUser(first, schema);
	const secondBackend = await backendOf(second);
	await first.query(`BEGIN ISOLATION LEVEL ${isolation}`, []);
	await second.query(`BEGIN ISOLATION LEVEL ${isolation}`, []);
	try {
		await first.query(lockAccountRowStatement(schema), [userId]);
		await sealInsert(first, userId);
		const secondLock = second.query(lockAccountRowStatement(schema), [userId]);
		const observer = await openTestConnection();
		try {
			await untilWaiting(observer, secondBackend);
		} finally {
			await observer.close();
		}
		await first.query("COMMIT", []);
		await secondLock;
		const [seen] = await second.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM ${schema}.security_state WHERE user_id = $1`,
			[userId],
		);
		const sqlState =
			seen?.n === 0
				? await sealInsert(second, userId)
						.then(() => "inserted")
						.catch((error: { sqlState?: string }) => error.sqlState ?? "no SQLSTATE")
				: "not attempted, the seal row was read";
		return { seen: seen?.n, sqlState };
	} finally {
		await first.query("ROLLBACK", []).catch(() => undefined);
		await second.query("ROLLBACK", []);
	}
}

describe("premise: two first seals of one account (section 3.18, Sealing)", () => {
	it("at READ COMMITTED the later one reads the seal row after the lock and inserts nothing", async () => {
		expect(await secondFirstSealAfterWaiting("READ COMMITTED")).toStrictEqual({
			seen: 1,
			sqlState: "not attempted, the seal row was read",
		});
	});

	it("control: at REPEATABLE READ the later one reads no seal row and fails with a unique violation", async () => {
		expect(await secondFirstSealAfterWaiting("REPEATABLE READ")).toStrictEqual({
			seen: 0,
			sqlState: "23505",
		});
	});
});
