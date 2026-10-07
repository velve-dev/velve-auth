import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockAccountRowStatement } from "../src/core/db/lock.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

// Section 3.18 *Sealing* runs a change at READ COMMITTED under the account lock, reads every seal
// component in one statement after the lock, and computes the new seal from that read and its own
// change, never from a second read. The account lock does not keep out a writer whose foreign key
// takes FOR KEY SHARE (E-1604). These cases hold what that rule rests on: the writer's commit
// goes through during the change, the read the seal is computed from does not contain it, a
// second read inside the change would, and the next check's read does, so the check detects it.
// The REPEATABLE READ rule this replaced is recorded in E-3280; T-INTEG-3's case against the
// sealing code itself belongs to the seal branch.

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

async function readsAcrossAWriterCommit(): Promise<{
	readonly sealedFrom: number;
	readonly secondReadInsideTheChange: number;
	readonly nextCheck: number;
}> {
	const userId = await createUser(owner, schema);
	await owner.query("BEGIN ISOLATION LEVEL READ COMMITTED", []);
	try {
		await owner.query(lockAccountRowStatement(schema), [userId]);
		const sealedFrom = await passkeysOf(userId);
		expect(await writerCommitsAForeignPasskey(userId)).toBe("committed");
		const secondReadInsideTheChange = await passkeysOf(userId);
		await owner.query("COMMIT", []);
		return { sealedFrom, secondReadInsideTheChange, nextCheck: await passkeysOf(userId) };
	} finally {
		await owner.query("ROLLBACK", []).catch(() => undefined);
	}
}

describe("premise: the account lock and a writer's insert during a change (section 3.18, Sealing)", () => {
	it("keeps the insert out of the one read the seal is computed from, and shows it to the next check", async () => {
		const reads = await readsAcrossAWriterCommit();
		expect({ sealedFrom: reads.sealedFrom, nextCheck: reads.nextCheck }).toStrictEqual({
			sealedFrom: 0,
			nextCheck: 1,
		});
	});

	it("control: a second read inside the change would contain it, which is why there is none", async () => {
		expect((await readsAcrossAWriterCommit()).secondReadInsideTheChange).toBe(1);
	});
});
