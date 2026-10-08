import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockAccountRowStatement } from "../src/core/db/lock.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

//a resolution that reads session and epoch in one statement raises no false alarm against a racing revocation (E-3299)

let resolver: TestConnection;
let revoker: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("resolve_revocation");
	resolver = migrated.connection;
	schema = migrated.schema;
	revoker = await openTestConnection();
});

afterAll(async () => {
	await dropSchema(resolver, schema);
	await resolver.close();
	await revoker.close();
});

async function sealedAccountWithSessionUnderEpochOne(): Promise<{
	userId: string;
	tokenHash: Buffer;
}> {
	const userId = await createUser(resolver, schema);
	await resolver.query(
		`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version, session_epoch)
		 VALUES ($1, 1, decode(repeat('00', 32), 'hex'), 1, 1)`,
		[userId],
	);
	const tokenHash = Buffer.alloc(32, 9);
	tokenHash.write(userId.replaceAll("-", "").slice(0, 16), "hex");
	await resolver.query(
		`INSERT INTO ${schema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at,
			   token_mac, token_mac_key_version)
		 VALUES ($1, $2, now() + interval '1 hour', now() + interval '1 day', decode(repeat('00', 32), 'hex'), 1)`,
		[userId, tokenHash],
	);
	return { userId, tokenHash };
}

async function revokeAllCommits(userId: string): Promise<void> {
	await revoker.query("BEGIN", []);
	await revoker.query(lockAccountRowStatement(schema), [userId]);
	await revoker.query(
		`UPDATE ${schema}.security_state SET session_epoch = session_epoch + 1, version = version + 1
		 WHERE user_id = $1`,
		[userId],
	);
	await revoker.query(`DELETE FROM ${schema}.session WHERE user_id = $1`, [userId]);
	await revoker.query("COMMIT", []);
}

const boundEpochOfTheIssue = 1;

function alarmFor(epoch: string | undefined): "token_binding_mismatch" | null {
	return Number(epoch) === boundEpochOfTheIssue ? null : "token_binding_mismatch";
}

async function resolveInOneStatement(tokenHash: Buffer) {
	const rows = await resolver.query<{ epoch: string }>(
		`SELECT st.session_epoch::text AS epoch FROM ${schema}.session s
		 JOIN ${schema}.user u ON u.id = s.user_id
		 JOIN ${schema}.security_state st ON st.user_id = s.user_id
		 WHERE s.token_sha256 = $1 AND s.idle_expires_at > now() AND s.absolute_expires_at > now()`,
		[tokenHash],
	);
	return rows.map((row) => alarmFor(row.epoch));
}

async function backendOf(connection: TestConnection): Promise<number> {
	const [row] = await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid", []);
	return row?.pid ?? -1;
}

async function untilRunning(backend: number): Promise<void> {
	for (let poll = 0; poll < 300; poll += 1) {
		const [row] = await revoker.query<{ n: number }>(
			"SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1 AND state = 'active' AND query LIKE '%pg_sleep%'",
			[backend],
		);
		if ((row?.n ?? 0) > 0) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("the resolution statement never ran");
}

async function slowOneStatementResolution(tokenHash: Buffer) {
	const rows = await resolver.query<{ epoch: string }>(
		`SELECT st.session_epoch::text AS epoch, pg_sleep(0.3)::text AS slept FROM ${schema}.session s
		 JOIN ${schema}.user u ON u.id = s.user_id
		 JOIN ${schema}.security_state st ON st.user_id = s.user_id
		 WHERE s.token_sha256 = $1 AND s.idle_expires_at > now() AND s.absolute_expires_at > now()`,
		[tokenHash],
	);
	return rows.map((row) => alarmFor(row.epoch));
}

describe("premise: a session resolution racing session.revokeAll (section 3.18, Checking)", () => {
	it("in one statement still in flight while the revocation commits raises no alarm", async () => {
		const { userId, tokenHash } = await sealedAccountWithSessionUnderEpochOne();
		const resolverBackend = await backendOf(resolver);
		const resolving = slowOneStatementResolution(tokenHash);
		await untilRunning(resolverBackend);
		await revokeAllCommits(userId);
		expect(await resolving).toStrictEqual([null]);
	});

	it("in one statement finds the session under its epoch before the revocation and no row after it", async () => {
		const { userId, tokenHash } = await sealedAccountWithSessionUnderEpochOne();
		const before = await resolveInOneStatement(tokenHash);
		await revokeAllCommits(userId);
		const after = await resolveInOneStatement(tokenHash);
		expect({ before, after }).toStrictEqual({ before: [null], after: [] });
	});

	it("control: two statements with the revocation between them raise a false alarm", async () => {
		const { userId, tokenHash } = await sealedAccountWithSessionUnderEpochOne();
		const [session] = await resolver.query<{ user_id: string }>(
			`SELECT s.user_id FROM ${schema}.session s JOIN ${schema}.user u ON u.id = s.user_id
			 WHERE s.token_sha256 = $1 AND s.idle_expires_at > now() AND s.absolute_expires_at > now()`,
			[tokenHash],
		);
		expect(session?.user_id).toBe(userId);
		await revokeAllCommits(userId);
		const [state] = await resolver.query<{ epoch: string }>(
			`SELECT session_epoch::text AS epoch FROM ${schema}.security_state WHERE user_id = $1`,
			[userId],
		);
		expect(alarmFor(state?.epoch)).toBe("token_binding_mismatch");
	});
});
