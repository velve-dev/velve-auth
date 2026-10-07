import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockAccountRowStatement } from "../src/core/db/lock.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

// Section 3.18 point 3: the session issue takes the account lock, reads the epoch and inserts
// only while that epoch still holds. The lock is FOR NO KEY UPDATE on velve.user, and an UPDATE of
// velve.security_state by a database writer takes no lock there, so the writer commits between
// the epoch read and the conditional insert and the insert inserts nothing. The specification
// therefore no longer says the condition cannot miss; a miss is a broken state, answered like a
// missing row with the alarm seal_mismatch and not retried (E-3298). This case holds the premise
// the rule rests on, and the control that the same statements insert one row when nobody writes.
// The issuing code that answers the miss is the token branch's.

let signer: TestConnection;
let writerConnection: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("issue_condition_miss");
	signer = migrated.connection;
	schema = migrated.schema;
	writerConnection = await openTestConnection();
});

afterAll(async () => {
	await dropSchema(signer, schema);
	await signer.close();
	await writerConnection.close();
});

function withinTwoSeconds<T>(work: Promise<T>): Promise<T | "blocked by the account lock"> {
	return Promise.race([
		work,
		new Promise<"blocked by the account lock">((resolve) =>
			setTimeout(() => resolve("blocked by the account lock"), 2_000),
		),
	]);
}

async function issueUnderTheLock(writerChangesTheEpoch: boolean) {
	const userId = await createUser(signer, schema);
	await signer.query(
		`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version, session_epoch)
		 VALUES ($1, 1, decode(repeat('00', 32), 'hex'), 1, 1)`,
		[userId],
	);
	await signer.query("BEGIN ISOLATION LEVEL READ COMMITTED", []);
	try {
		await signer.query(lockAccountRowStatement(schema), [userId]);
		const [state] = await signer.query<{ epoch: string }>(
			`SELECT session_epoch::text AS epoch FROM ${schema}.security_state WHERE user_id = $1`,
			[userId],
		);
		const writer = writerChangesTheEpoch
			? await withinTwoSeconds(
					writerConnection
						.query(`UPDATE ${schema}.security_state SET session_epoch = 7 WHERE user_id = $1`, [
							userId,
						])
						.then(() => "committed"),
				)
			: "did not write";
		const inserted = await signer.query(
			`INSERT INTO ${schema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at)
			 SELECT s.user_id, decode(md5(random()::text) || md5(random()::text), 'hex'),
				now() + interval '1 hour', now() + interval '1 day'
			 FROM ${schema}.security_state s WHERE s.user_id = $1 AND s.session_epoch = $2
			 RETURNING id`,
			[userId, Number(state?.epoch)],
		);
		return { writer, inserted: inserted.length };
	} finally {
		await signer.query("ROLLBACK", []).catch(() => undefined);
	}
}

describe("the session issue's conditional insert under the account lock (section 3.18 point 3)", () => {
	it("misses when a writer changes the epoch under the lock, which is why a miss is a broken state", async () => {
		expect(await issueUnderTheLock(true)).toStrictEqual({ writer: "committed", inserted: 0 });
	});

	it("control: the same statements insert the session when nobody writes", async () => {
		expect(await issueUnderTheLock(false)).toStrictEqual({ writer: "did not write", inserted: 1 });
	});
});
