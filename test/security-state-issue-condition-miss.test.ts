import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockAccountRowStatement } from "../src/core/db/lock.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

//a writer's update of security_state passes the account lock that blocks an update of the locked user row (E-3343)

let signer: TestConnection;
let writerConnection: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("issue_condition_miss");
	signer = migrated.connection;
	schema = migrated.schema;
	writerConnection = await openTestConnection();
	await writerConnection.query("SET lock_timeout = '200ms'", []);
});

afterAll(async () => {
	await dropSchema(signer, schema);
	await signer.close();
	await writerConnection.close();
});

function writerUpdate(sql: string, userId: string): Promise<string> {
	return writerConnection
		.query(sql, [userId])
		.then(() => "committed")
		.catch((error: { sqlState?: string }) => error.sqlState ?? "no SQLSTATE");
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
			? await writerUpdate(
					`UPDATE ${schema}.security_state SET session_epoch = 7 WHERE user_id = $1`,
					userId,
				)
			: "did not write";
		const lockedRow = await writerUpdate(
			`UPDATE ${schema}.user SET updated_at = now() WHERE id = $1`,
			userId,
		);
		const inserted = await signer.query(
			`INSERT INTO ${schema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at,
			   token_mac, token_mac_key_version)
			 SELECT s.user_id, decode(md5(random()::text) || md5(random()::text), 'hex'),
				now() + interval '1 hour', now() + interval '1 day', decode(repeat('00', 32), 'hex'), 1
			 FROM ${schema}.security_state s WHERE s.user_id = $1 AND s.session_epoch = $2
			 RETURNING id`,
			[userId, Number(state?.epoch)],
		);
		return { writer, lockedRow, inserted: inserted.length };
	} finally {
		await signer.query("ROLLBACK", []).catch(() => undefined);
	}
}

describe("premise: the session issue's conditional insert under the account lock (section 3.18 point 3)", () => {
	it("misses when a writer changes the epoch under the lock, which is why a miss is a broken state", async () => {
		expect(await issueUnderTheLock(true)).toStrictEqual({
			writer: "committed",
			lockedRow: "55P03",
			inserted: 0,
		});
	});

	it("control: the same statements insert the session when nobody writes", async () => {
		expect(await issueUnderTheLock(false)).toStrictEqual({
			writer: "did not write",
			lockedRow: "55P03",
			inserted: 1,
		});
	});
});
