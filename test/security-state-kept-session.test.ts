import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockAccountRowStatement } from "../src/core/db/lock.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

//the kept session is checked again under the lock and the bound epoch is modelled until the token branch adds its columns (E-3301)

let caller: TestConnection;
let victim: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("kept_session");
	caller = migrated.connection;
	schema = migrated.schema;
	victim = await openTestConnection();
});

afterAll(async () => {
	await dropSchema(caller, schema);
	await caller.close();
	await victim.close();
});

async function revokeAllOtherAfterARevocationAndAReinsert(
	checkKeptUnderTheLock: boolean,
	writerReinserts = true,
) {
	const boundEpoch = new Map<string, number>();
	const userId = await createUser(caller, schema);
	await caller.query(
		`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version, session_epoch)
		 VALUES ($1, 1, decode(repeat('00', 32), 'hex'), 1, 1)`,
		[userId],
	);
	const [saved] = await caller.query<Record<string, unknown>>(
		`INSERT INTO ${schema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at)
		 VALUES ($1, decode(md5(random()::text) || md5(random()::text), 'hex'),
		 now() + interval '1 hour', now() + interval '1 day')
		 RETURNING *`,
		[userId],
	);
	const keptId = String(saved?.id);
	boundEpoch.set(keptId, 1);

	const [resolvedEpoch] = await caller.query<{ epoch: string }>(
		`SELECT st.session_epoch::text AS epoch FROM ${schema}.session s
		 JOIN ${schema}.security_state st ON st.user_id = s.user_id WHERE s.id = $1`,
		[keptId],
	);
	expect(Number(resolvedEpoch?.epoch)).toBe(boundEpoch.get(keptId));

	await victim.query("BEGIN", []);
	await victim.query(lockAccountRowStatement(schema), [userId]);
	await victim.query(
		`UPDATE ${schema}.security_state SET session_epoch = session_epoch + 1, version = version + 1
		 WHERE user_id = $1`,
		[userId],
	);
	await victim.query(`DELETE FROM ${schema}.session WHERE user_id = $1`, [userId]);
	await victim.query("COMMIT", []);

	const columns = Object.keys(saved ?? {});
	if (writerReinserts) {
		await victim.query(
			`INSERT INTO ${schema}.session (${columns.join(", ")})
		 VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
			columns.map((column) => saved?.[column]),
		);
	}

	await caller.query("BEGIN", []);
	let alarms = 0;
	try {
		await caller.query(lockAccountRowStatement(schema), [userId]);
		const [underTheLock] = await caller.query<{ epoch: string }>(
			`SELECT session_epoch::text AS epoch FROM ${schema}.security_state WHERE user_id = $1`,
			[userId],
		);
		const keptRow = await caller.query(`SELECT 1 FROM ${schema}.session WHERE id = $1`, [keptId]);
		const keptStillVerifies = boundEpoch.get(keptId) === Number(underTheLock?.epoch);
		const keep = !checkKeptUnderTheLock || keptStillVerifies;
		if (!keep && keptRow.length === 1) {
			alarms += 1;
		}
		const [raised] = await caller.query<{ epoch: string }>(
			`UPDATE ${schema}.security_state SET session_epoch = session_epoch + 1, version = version + 1
			 WHERE user_id = $1 RETURNING session_epoch::text AS epoch`,
			[userId],
		);
		await caller.query(
			`DELETE FROM ${schema}.session WHERE user_id = $1 AND ($3::boolean IS FALSE OR id <> $2)`,
			[userId, keptId, keep],
		);
		const rebound = await caller.query(
			`UPDATE ${schema}.session SET last_used_at = now() WHERE id = $1 RETURNING id`,
			[keptId],
		);
		if (rebound.length === 1) {
			boundEpoch.set(keptId, Number(raised?.epoch));
		}
		await caller.query("COMMIT", []);
	} finally {
		await caller.query("ROLLBACK", []).catch(() => undefined);
	}

	const [current] = await caller.query<{ epoch: string }>(
		`SELECT session_epoch::text AS epoch FROM ${schema}.security_state WHERE user_id = $1`,
		[userId],
	);
	const stillPresent = await caller.query(`SELECT 1 FROM ${schema}.session WHERE id = $1`, [
		keptId,
	]);
	return {
		resolvesAgain: stillPresent.length === 1 && boundEpoch.get(keptId) === Number(current?.epoch),
		alarms,
	};
}

describe("premise: the session revokeAllOther keeps, against a revokeAll that ended it (section 3.18, Sealing)", () => {
	it("in the model is checked under the lock, does not come back and counts one alarm", async () => {
		expect(await revokeAllOtherAfterARevocationAndAReinsert(true)).toStrictEqual({
			resolvesAgain: false,
			alarms: 1,
		});
	});

	it("in the model keeps nothing and counts no alarm when a legitimate revokeAll deleted the row and nobody reinserted it", async () => {
		expect(await revokeAllOtherAfterARevocationAndAReinsert(true, false)).toStrictEqual({
			resolvesAgain: false,
			alarms: 0,
		});
	});

	it("control: an unconditional rebind lifts the reinserted row under the current epoch", async () => {
		expect(await revokeAllOtherAfterARevocationAndAReinsert(false)).toStrictEqual({
			resolvesAgain: true,
			alarms: 0,
		});
	});
});
