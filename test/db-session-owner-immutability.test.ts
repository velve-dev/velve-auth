import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { PostgresServerError } from "./db-postgres-connection.js";

let migrated: MigratedSchema;
let owner: string;
let stranger: string;

async function createSession(userId: string): Promise<string> {
	const [row] = await migrated.connection.query<{ id: string }>(
		`INSERT INTO ${migrated.schema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at)
		 VALUES ($1, $2, now() + interval '1 day', now() + interval '30 days') RETURNING id`,
		[userId, randomBytes(32)],
	);
	if (row === undefined) {
		throw new Error("the session was not created");
	}
	return row.id;
}

async function ownerOf(sessionId: string): Promise<string | undefined> {
	const [row] = await migrated.connection.query<{ user_id: string }>(
		`SELECT user_id FROM ${migrated.schema}.session WHERE id = $1`,
		[sessionId],
	);
	return row?.user_id;
}

async function expectRefused(sql: string, params: unknown[] = []): Promise<void> {
	await expect(migrated.connection.query(sql, params)).rejects.toBeInstanceOf(PostgresServerError);
}

beforeAll(async () => {
	migrated = await openMigratedSchema("velve_owner");
	owner = await createUser(migrated.connection, migrated.schema);
	stranger = await createUser(migrated.connection, migrated.schema);
});

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

describe("the session owner column cannot be rewritten (E-23, S-FIX-2)", () => {
	it("refuses a direct reassignment", async () => {
		const sessionId = await createSession(owner);

		await expectRefused(`UPDATE ${migrated.schema}.session SET user_id = $1 WHERE id = $2`, [
			stranger,
			sessionId,
		]);

		expect(await ownerOf(sessionId)).toBe(owner);
	});

	it("refuses an assignment that changes nothing", async () => {
		const sessionId = await createSession(owner);

		await expect(
			migrated.connection.query(
				`UPDATE ${migrated.schema}.session SET user_id = user_id WHERE id = $1`,
				[sessionId],
			),
		).rejects.toMatchObject({ sqlState: "23514" });
	});

	it("refuses an update that also writes permitted columns", async () => {
		const sessionId = await createSession(owner);

		await expectRefused(
			`UPDATE ${migrated.schema}.session SET last_used_at = now(), user_agent = 'probe', user_id = $1
			 WHERE id = $2`,
			[stranger, sessionId],
		);

		expect(await ownerOf(sessionId)).toBe(owner);
	});

	it("refuses an update that touches many rows at once", async () => {
		await createSession(owner);
		await createSession(owner);

		await expectRefused(`UPDATE ${migrated.schema}.session SET user_id = $1`, [stranger]);
	});

	it("refuses an update whose new owner comes from a joined table", async () => {
		const sessionId = await createSession(owner);

		await expectRefused(
			`UPDATE ${migrated.schema}.session s SET user_id = u.id
			 FROM ${migrated.schema}.user u WHERE u.id = $1 AND s.id = $2`,
			[stranger, sessionId],
		);

		expect(await ownerOf(sessionId)).toBe(owner);
	});

	it("refuses an update hidden inside a data-modifying CTE", async () => {
		const sessionId = await createSession(owner);

		await expectRefused(
			`WITH moved AS (
			   UPDATE ${migrated.schema}.session SET user_id = $1 WHERE id = $2 RETURNING id
			 ) SELECT count(*) FROM moved`,
			[stranger, sessionId],
		);

		expect(await ownerOf(sessionId)).toBe(owner);
	});

	it("refuses an update issued from inside a database function", async () => {
		const sessionId = await createSession(owner);
		await migrated.connection.query(
			`CREATE FUNCTION ${migrated.schema}.move_session(target uuid, recipient uuid)
			 RETURNS void LANGUAGE plpgsql AS $body$
			 BEGIN
			   UPDATE ${migrated.schema}.session SET user_id = recipient WHERE id = target;
			 END
			 $body$`,
			[],
		);

		await expectRefused(`SELECT ${migrated.schema}.move_session($1, $2)`, [sessionId, stranger]);

		expect(await ownerOf(sessionId)).toBe(owner);
	});

	it("refuses a MERGE that updates the owner", async () => {
		const sessionId = await createSession(owner);

		await expectRefused(
			`MERGE INTO ${migrated.schema}.session s
			 USING ${migrated.schema}.user u ON u.id = $1 AND s.id = $2
			 WHEN MATCHED THEN UPDATE SET user_id = u.id`,
			[stranger, sessionId],
		);

		expect(await ownerOf(sessionId)).toBe(owner);
	});

	it("leaves every other column writable", async () => {
		const sessionId = await createSession(owner);

		await migrated.connection.query(
			`UPDATE ${migrated.schema}.session SET last_used_at = now(), factors = '{password}'
			 WHERE id = $1`,
			[sessionId],
		);

		const [row] = await migrated.connection.query<{ factors: string }>(
			`SELECT factors FROM ${migrated.schema}.session WHERE id = $1`,
			[sessionId],
		);
		expect(row?.factors).toBe("{password}");
	});
});
