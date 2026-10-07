import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockAccountRowStatement } from "../src/core/db/lock.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

//a session issue takes the account lock before it reads the epoch and inserts conditionally, the premise of T-INTEG-3's sign-ins racing a revocation (E-3207)

let revoker: TestConnection;
let signer: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("session_issue");
	revoker = migrated.connection;
	schema = migrated.schema;
	signer = await openTestConnection();
});

afterAll(async () => {
	await dropSchema(revoker, schema);
	await revoker.close();
	await signer.close();
});

async function sealedAccount(): Promise<string> {
	const userId = await createUser(revoker, schema);
	await revoker.query(
		`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version, session_epoch)
		 VALUES ($1, 1, decode(repeat('00', 32), 'hex'), 1, 1)`,
		[userId],
	);
	return userId;
}

function insertUnderEpoch(userId: string, epoch: number): Promise<number> {
	return signer
		.query(
			`INSERT INTO ${schema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at)
			 SELECT s.user_id, decode(md5(random()::text) || md5(random()::text), 'hex'),
				now() + interval '1 hour', now() + interval '1 day'
			 FROM ${schema}.security_state s WHERE s.user_id = $1 AND s.session_epoch = $2
			 RETURNING id`,
			[userId, epoch],
		)
		.then((rows) => rows.length);
}

async function epochOf(userId: string): Promise<number> {
	const [row] = await signer.query<{ epoch: string }>(
		`SELECT session_epoch::text AS epoch FROM ${schema}.security_state WHERE user_id = $1`,
		[userId],
	);
	return Number(row?.epoch);
}

function withinOneAndAHalfSeconds<T>(work: Promise<T>): Promise<T | "blocked"> {
	return Promise.race([
		work,
		new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 1_500)),
	]);
}

async function beginMassRevocation(userId: string): Promise<void> {
	await revoker.query("BEGIN", []);
	await revoker.query(lockAccountRowStatement(schema), [userId]);
	await revoker.query(
		`UPDATE ${schema}.security_state SET session_epoch = 2, version = 2 WHERE user_id = $1`,
		[userId],
	);
	await revoker.query(`DELETE FROM ${schema}.session WHERE user_id = $1`, [userId]);
}

describe("premise: a session issued while a mass revocation raises the epoch (section 3.18 point 3)", () => {
	it("control: without the lock, an insert under the epoch read before the raise survives it", async () => {
		const userId = await sealedAccount();
		await beginMassRevocation(userId);
		try {
			const inserted = await withinOneAndAHalfSeconds(insertUnderEpoch(userId, 1));
			expect(inserted).toBe(1);
		} finally {
			await revoker.query("COMMIT", []);
		}
	});

	it("with the lock first, waits for the revocation and then inserts under the raised epoch", async () => {
		const userId = await sealedAccount();
		await beginMassRevocation(userId);
		await signer.query("BEGIN", []);
		try {
			const locked = signer.query(lockAccountRowStatement(schema), [userId]);
			expect(await withinOneAndAHalfSeconds(locked)).toBe("blocked");
			await revoker.query("COMMIT", []);
			await locked;
			const epoch = await epochOf(userId);
			expect({ epoch, stale: await insertUnderEpoch(userId, 1) }).toStrictEqual({
				epoch: 2,
				stale: 0,
			});
			expect(await insertUnderEpoch(userId, epoch)).toBe(1);
		} finally {
			await signer.query("ROLLBACK", []);
		}
	});
});

describe("premise: a session of an account without a seal row (section 3.18 point 3, migrating)", () => {
	function insertForUnsealed(userId: string): Promise<number> {
		return signer
			.query(
				`INSERT INTO ${schema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at)
				 SELECT $1, decode(md5(random()::text) || md5(random()::text), 'hex'),
					now() + interval '1 hour', now() + interval '1 day'
				 WHERE NOT EXISTS (SELECT 1 FROM ${schema}.security_state WHERE user_id = $1)
				 RETURNING id`,
				[userId],
			)
			.then((rows) => rows.length);
	}

	it("inserts against epoch 1 while the account has no seal row", async () => {
		const userId = await createUser(revoker, schema);
		expect(await insertForUnsealed(userId)).toBe(1);
	});

	it("inserts nothing through that statement once the account is sealed", async () => {
		const userId = await sealedAccount();
		expect(await insertForUnsealed(userId)).toBe(0);
	});
});
