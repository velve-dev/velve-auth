import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionService, type SessionService } from "../src/core/session/service.js";
import { actorOfTestUser, createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";

// A database writer saves a session row, waits for the user to sign out everywhere, and inserts
// the saved row again. Section 3.18 binds every session MAC to the account's session_epoch, which
// a mass revocation raises, so the row must resolve to nothing. The epoch is bound on the branch
// that builds the token MACs; until it is, the case below is expected to fail, so it records the
// gap instead of hiding it. That branch turns it into a plain it, which this file then fails on
// (E-3107).

let connection: TestConnection;
let schema: string;
let sessions: SessionService;

const OBSERVED = { ipAddress: null, userAgent: null };

beforeAll(async () => {
	const migrated = await openMigratedSchema("session_epoch");
	connection = migrated.connection;
	schema = migrated.schema;
	sessions = createSessionService({ driver: connection, schema });
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

describe("a session row replayed after a mass revocation (section 3.18, T-INTEG-9)", () => {
	it.fails("resolves to nothing once every session of the account was revoked", async () => {
		const userId = await createUser(connection, schema);
		const { token, session } = await sessions.issue({
			userId,
			factors: ["password"],
			observed: OBSERVED,
		});
		const saved = await connection.query<Record<string, unknown>>(
			`SELECT * FROM ${schema}.session WHERE id = $1`,
			[session.id],
		);

		await sessions.revokeEverySessionOfUser({ actor: actorOfTestUser(userId) });
		const [row] = saved;
		if (row === undefined) {
			throw new Error("the issued session left no row to save");
		}
		const columns = Object.keys(row);
		await connection.query(
			`INSERT INTO ${schema}.session (${columns.join(", ")})
			 VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
			columns.map((column) => row[column]),
		);

		expect(await sessions.resolve(token)).toBeNull();
	});
});
