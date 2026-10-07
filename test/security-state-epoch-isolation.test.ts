import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockAccountRowStatement } from "../src/core/db/lock.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

// Section 3.18 runs session issue and every mass revocation at READ COMMITTED under the account
// lock: an issue reads the epoch after the lock, and a revocation's DELETE, a statement after the
// lock, sees every session committed while it waited. The cases hold that rule against
// PostgreSQL, and the controls hold the failure of the REPEATABLE READ rule it replaced, whose
// snapshot was taken by the waiting lock statement and so missed what the lock holder committed
// (E-3280).

let first: TestConnection;
let second: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("epoch_isolation");
	first = migrated.connection;
	schema = migrated.schema;
	second = await openTestConnection();
});

afterAll(async () => {
	await dropSchema(first, schema);
	await first.close();
	await second.close();
});

async function sealedAccount(): Promise<string> {
	const userId = await createUser(first, schema);
	await first.query(
		`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version, session_epoch)
		 VALUES ($1, 1, decode(repeat('00', 32), 'hex'), 1, 1)`,
		[userId],
	);
	return userId;
}

function insertUnderEpoch(connection: TestConnection, userId: string, epoch: number) {
	return connection
		.query<{ id: string }>(
			`INSERT INTO ${schema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at)
			 SELECT s.user_id, decode(md5(random()::text) || md5(random()::text), 'hex'),
				now() + interval '1 hour', now() + interval '1 day'
			 FROM ${schema}.security_state s WHERE s.user_id = $1 AND s.session_epoch = $2
			 RETURNING id`,
			[userId, epoch],
		)
		.then((rows) => rows.length);
}

async function epochOn(connection: TestConnection, userId: string): Promise<number> {
	const [row] = await connection.query<{ epoch: string }>(
		`SELECT session_epoch::text AS epoch FROM ${schema}.security_state WHERE user_id = $1`,
		[userId],
	);
	return Number(row?.epoch);
}

async function sessionsOf(userId: string): Promise<number> {
	const [row] = await first.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM ${schema}.session WHERE user_id = $1`,
		[userId],
	);
	return row?.n ?? -1;
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

async function revocationWaitingOnAnIssue(isolation: string) {
	const userId = await sealedAccount();
	const observer = await openTestConnection();
	try {
		const revokerBackend = await backendOf(second);
		await first.query("BEGIN", []);
		await first.query(lockAccountRowStatement(schema), [userId]);
		expect(await insertUnderEpoch(first, userId, 1)).toBe(1);

		await second.query(`BEGIN ISOLATION LEVEL ${isolation}`, []);
		const locked = second.query(lockAccountRowStatement(schema), [userId]);
		await untilWaiting(observer, revokerBackend);
		await first.query("COMMIT", []);
		await locked;
		await second.query(`DELETE FROM ${schema}.session WHERE user_id = $1`, [userId]);
		await second.query(
			`UPDATE ${schema}.security_state SET session_epoch = session_epoch + 1, version = version + 1
				 WHERE user_id = $1`,
			[userId],
		);
		await second.query("COMMIT", []);

		return { surviving: await sessionsOf(userId), epoch: await epochOn(first, userId) };
	} finally {
		await first.query("ROLLBACK", []).catch(() => undefined);
		await second.query("ROLLBACK", []).catch(() => undefined);
		await observer.close();
	}
}

async function issueWaitingOnARevocation(isolation: string) {
	const userId = await sealedAccount();
	const observer = await openTestConnection();
	try {
		const signerBackend = await backendOf(second);
		await first.query("BEGIN", []);
		await first.query(lockAccountRowStatement(schema), [userId]);
		await first.query(
			`UPDATE ${schema}.security_state SET session_epoch = 2, version = 2 WHERE user_id = $1`,
			[userId],
		);
		await first.query(`DELETE FROM ${schema}.session WHERE user_id = $1`, [userId]);

		await second.query(`BEGIN ISOLATION LEVEL ${isolation}`, []);
		const locked = second.query(lockAccountRowStatement(schema), [userId]);
		await untilWaiting(observer, signerBackend);
		await first.query("COMMIT", []);
		await locked;
		const epoch = await epochOn(second, userId);
		const staleInserted = await insertUnderEpoch(second, userId, epoch);
		await second.query("COMMIT", []);
		return { epochRead: epoch, insertedUnder: staleInserted === 1 ? epoch : null };
	} finally {
		await first.query("ROLLBACK", []).catch(() => undefined);
		await second.query("ROLLBACK", []).catch(() => undefined);
		await observer.close();
	}
}

describe("a mass revocation that waited on the account lock (section 3.18, Sealing)", () => {
	it("at READ COMMITTED deletes the session the lock holder committed", async () => {
		expect(await revocationWaitingOnAnIssue("READ COMMITTED")).toStrictEqual({
			surviving: 0,
			epoch: 2,
		});
	});

	it("control: at REPEATABLE READ leaves it alive under the old epoch", async () => {
		expect(await revocationWaitingOnAnIssue("REPEATABLE READ")).toStrictEqual({
			surviving: 1,
			epoch: 2,
		});
	});
});

describe("a session issue that waited on the account lock (section 3.18 point 3)", () => {
	it("at READ COMMITTED reads the raised epoch and inserts under it", async () => {
		expect(await issueWaitingOnARevocation("READ COMMITTED")).toStrictEqual({
			epochRead: 2,
			insertedUnder: 2,
		});
	});

	it("control: at REPEATABLE READ reads the epoch the revocation replaced", async () => {
		expect(await issueWaitingOnARevocation("REPEATABLE READ")).toStrictEqual({
			epochRead: 1,
			insertedUnder: 1,
		});
	});
});
