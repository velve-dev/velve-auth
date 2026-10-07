import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockAccountRowStatement } from "../src/core/db/lock.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

// Section 3.18 *Sealing* runs a change at REPEATABLE READ with the snapshot taken by the lock
// statement, because the account lock does not keep out a writer whose foreign key takes FOR KEY
// SHARE (E-1604). These cases hold the premise the seal branch builds on: under READ COMMITTED a
// passkey a writer commits after the lock is visible to the recomputation, and under the
// snapshot it is not. T-INTEG-3's case against the sealing code itself belongs to that branch,
// which has the code to call (E-3193).

let owner: TestConnection;
let writer: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("seal_snapshot");
	owner = migrated.connection;
	schema = migrated.schema;
	writer = await openTestConnection();
});

afterAll(async () => {
	await dropSchema(owner, schema);
	await owner.close();
	await writer.close();
});

async function passkeysOf(userId: string): Promise<number> {
	const [row] = await owner.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM ${schema}.webauthn_credential WHERE user_id = $1`,
		[userId],
	);
	return row?.n ?? -1;
}

async function writerCommitsAForeignPasskey(userId: string): Promise<string> {
	const committed = writer
		.query(
			`INSERT INTO ${schema}.webauthn_credential
			 (user_id, credential_id, public_key, backup_eligible, backup_state, user_verified_at_registration)
			 VALUES ($1, decode(md5(random()::text), 'hex'), decode('bb', 'hex'), false, false, true)`,
			[userId],
		)
		.then(() => "committed");
	return Promise.race([
		committed,
		new Promise<string>((resolve) =>
			setTimeout(() => resolve("blocked by the account lock"), 2_000),
		),
	]);
}

async function readsAcrossAWriterCommit(isolation: string): Promise<readonly [number, number]> {
	const userId = await createUser(owner, schema);
	await owner.query(`BEGIN ISOLATION LEVEL ${isolation}`, []);
	try {
		await owner.query(lockAccountRowStatement(schema), [userId]);
		const atCheck = await passkeysOf(userId);
		expect(await writerCommitsAForeignPasskey(userId)).toBe("committed");
		const atRecompute = await passkeysOf(userId);
		return [atCheck, atRecompute];
	} finally {
		await owner.query("ROLLBACK", []);
	}
}

describe("the account lock and a writer's insert during a change (section 3.18, Sealing)", () => {
	it("lets the insert through and shows it to a READ COMMITTED recomputation", async () => {
		expect(await readsAcrossAWriterCommit("READ COMMITTED")).toStrictEqual([0, 1]);
	});

	it("keeps it out of a REPEATABLE READ snapshot the lock statement took", async () => {
		expect(await readsAcrossAWriterCommit("REPEATABLE READ")).toStrictEqual([0, 0]);
	});
});
