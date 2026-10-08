import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionService, type SessionService } from "../src/core/session/service.js";
import { testKeyProvider } from "./auth-fixtures.js";
import { actorOfTestUser, createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";

//a session row reinserted after a mass revocation must not resolve once the token branch binds the epoch (E-3196)

let connection: TestConnection;
let schema: string;
let sessions: SessionService;

const OBSERVED = { ipAddress: null, userAgent: null };

beforeAll(async () => {
	const migrated = await openMigratedSchema("session_epoch");
	connection = migrated.connection;
	schema = migrated.schema;
	sessions = createSessionService({
		sealing: "migrating",
		driver: connection,
		keys: testKeyProvider(),
		schema,
	});
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

async function replayAfterRevokingEverySession(): Promise<{
	readonly userId: string;
	readonly token: string;
}> {
	const userId = await createUser(connection, schema);
	const { token, session } = await sessions.issue({
		authorisedBy: "read_under_lock",
		userId,
		factors: ["password"],
		observed: OBSERVED,
	});
	//the row is saved inside the database so its created_at keeps the microseconds the MAC binds
	const saved = `${schema}.saved_session_${session.id.replaceAll("-", "")}`;
	await connection.query(`CREATE TABLE ${saved} AS SELECT * FROM ${schema}.session WHERE id = $1`, [
		session.id,
	]);

	await sessions.revokeEverySessionOfUser({ actor: actorOfTestUser(userId) });
	await connection.query(`INSERT INTO ${schema}.session SELECT * FROM ${saved}`, []);

	return { userId, token };
}

describe("a session row replayed after a mass revocation (section 3.18, T-INTEG-9)", () => {
	it("control: today the replayed row resolves", async () => {
		const { token } = await replayAfterRevokingEverySession();
		expect(await sessions.resolve(token)).not.toBeNull();
	});

	it("control: a session issued after the revocation resolves", async () => {
		const { userId } = await replayAfterRevokingEverySession();
		const later = await sessions.issue({
			authorisedBy: "read_under_lock",
			userId,
			factors: ["password"],
			observed: OBSERVED,
		});
		expect(await sessions.resolve(later.token)).not.toBeNull();
	});

	it.fails("resolves to nothing once every session of the account was revoked", async () => {
		const { token } = await replayAfterRevokingEverySession();
		expect(await sessions.resolve(token)).toBeNull();
	});
});
