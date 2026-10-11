import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { lockAccountRowStatement } from "../src/core/db/lock.js";
import { withReadCommittedTransactions } from "../src/core/db/read-committed.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

//every transaction the library opens runs at read committed even where the database default is repeatable read (E-3310)

let issuer: TestConnection;
let revoker: TestConnection;
let observer: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("read_committed_transactions");
	issuer = migrated.connection;
	schema = migrated.schema;
	revoker = await openTestConnection();
	observer = await openTestConnection();
	await issuer.query("SET default_transaction_isolation = 'repeatable read'", []);
	await revoker.query("SET default_transaction_isolation = 'repeatable read'", []);
});

afterAll(async () => {
	await dropSchema(observer, schema);
	await issuer.close();
	await revoker.close();
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
	throw new Error("the revocation never waited on the account lock");
}

async function sessionsAliveAfterARevocationWaitingOnAnIssue(
	open: (connection: TestConnection) => Driver,
): Promise<number> {
	const userId = await createUser(observer, schema);
	await observer.query(
		`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version, session_epoch)
		 VALUES ($1, 1, decode(repeat('00', 32), 'hex'), 1, 1)`,
		[userId],
	);
	const revokerBackend = await backendOf(revoker);
	let issued: () => void = () => undefined;
	const sessionInserted = new Promise<void>((resolve) => {
		issued = resolve;
	});
	let commitIssue: () => void = () => undefined;
	const issueMayCommit = new Promise<void>((resolve) => {
		commitIssue = resolve;
	});

	const issue = open(issuer).transaction(async (tx) => {
		await tx.query(lockAccountRowStatement(schema), [userId]);
		await tx.query(
			`INSERT INTO ${schema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at,
			   token_mac, token_mac_key_version)
			 VALUES ($1, decode(md5(random()::text) || md5(random()::text), 'hex'),
			 now() + interval '1 hour', now() + interval '1 day', decode(repeat('00', 32), 'hex'), 1)`,
			[userId],
		);
		issued();
		await issueMayCommit;
	});
	await sessionInserted;
	const revocation = open(revoker).transaction(async (tx) => {
		await tx.query(lockAccountRowStatement(schema), [userId]);
		await tx.query(`DELETE FROM ${schema}.session WHERE user_id = $1`, [userId]);
		await tx.query(
			`UPDATE ${schema}.security_state SET session_epoch = session_epoch + 1, version = version + 1
			 WHERE user_id = $1`,
			[userId],
		);
	});
	await untilWaiting(revokerBackend);
	commitIssue();
	await Promise.all([issue, revocation]);

	const [alive] = await observer.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM ${schema}.session WHERE user_id = $1`,
		[userId],
	);
	return alive?.n ?? -1;
}

describe("transactions the library opens, on connections whose default is repeatable read", () => {
	it("run at READ COMMITTED, so a mass revocation waiting on a session issue leaves no session", async () => {
		const [level] = await issuer.query<{ level: string }>(
			"SELECT current_setting('default_transaction_isolation') AS level",
			[],
		);
		expect(level?.level).toBe("repeatable read");
		expect(await sessionsAliveAfterARevocationWaitingOnAnIssue(withReadCommittedTransactions)).toBe(
			0,
		);
	});

	it("control: the underlying driver's plain BEGIN inherits repeatable read and the session survives", async () => {
		expect(await sessionsAliveAfterARevocationWaitingOnAnIssue((connection) => connection)).toBe(1);
	});

	it("states the isolation as the first statement of the transaction", async () => {
		const level = await withReadCommittedTransactions(issuer).transaction(async (tx) => {
			const [row] = await tx.query<{ level: string }>(
				"SELECT current_setting('transaction_isolation') AS level",
				[],
			);
			return row?.level;
		});
		expect(level).toBe("read committed");
	});
});
