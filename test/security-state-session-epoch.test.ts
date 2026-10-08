import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealedComponentsOf } from "../src/core/security-state/read.js";
import { sealChange } from "../src/core/security-state/runtime.js";
import { createSessionService, type SessionService } from "../src/core/session/service.js";
import { testKeyProvider } from "./auth-fixtures.js";
import { actorOfTestUser, createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { testSecurityState } from "./security-state-fixtures.js";

//a session row reinserted after a mass revocation must not resolve under the epoch the revocation drew (E-3196)

let connection: TestConnection;
let schema: string;
let sessions: SessionService;
const keys = testKeyProvider();

const OBSERVED = { ipAddress: null, userAgent: null };

beforeAll(async () => {
	const migrated = await openMigratedSchema("session_epoch");
	connection = migrated.connection;
	schema = migrated.schema;
	sessions = createSessionService({
		sealing: "migrating",
		driver: connection,
		keys,
		schema,
	});
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

//a mass revocation of the library deletes the rows in the sealing transaction that draws the new epoch (S-INTEG-3)
async function revokedUnderANewEpoch(userId: string): Promise<void> {
	const actor = actorOfTestUser(userId);
	await sealChange(testSecurityState(connection, schema, keys), actor, {
		epoch: "raise",
		write: (tx) => sessions.boundTo(tx).revokeEverySessionOfUser({ actor }),
		after: (read) => sealedComponentsOf(read),
	});
}

async function replayAfterRevokingEverySession(
	revocation: "under a new epoch" | "by deletion alone" = "under a new epoch",
): Promise<{
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

	if (revocation === "under a new epoch") {
		await revokedUnderANewEpoch(userId);
	} else {
		await sessions.revokeEverySessionOfUser({ actor: actorOfTestUser(userId) });
	}
	await connection.query(`INSERT INTO ${schema}.session SELECT * FROM ${saved}`, []);

	return { userId, token };
}

describe("a session row replayed after a mass revocation (section 3.18, T-INTEG-9)", () => {
	it("control: a deletion that draws no new epoch lets the replayed row resolve", async () => {
		const { token } = await replayAfterRevokingEverySession("by deletion alone");
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

	it("resolves to nothing once every session of the account was revoked", async () => {
		const { token } = await replayAfterRevokingEverySession();
		expect(await sessions.resolve(token)).toBeNull();
	});
});

//a change without a proof of ownership never writes a first seal, and its revocation still reaches every row (E-3162)
describe("a mass revocation without a proof of ownership on an unsealed account", () => {
	it("deletes every session and leaves the account unsealed", async () => {
		const userId = await createUser(connection, schema);
		for (let issued = 0; issued < 3; issued += 1) {
			await sessions.issue({
				authorisedBy: "unsealed",
				userId,
				factors: ["password"],
				observed: OBSERVED,
			});
		}
		const actor = actorOfTestUser(userId);

		const sealed = await sealChange(
			testSecurityState(connection, schema, keys),
			{ unproven: userId },
			{
				epoch: "raise",
				write: (tx) => sessions.boundTo(tx).revokeEverySessionOfUser({ actor }),
				after: (read) => sealedComponentsOf(read),
			},
		);
		const [left] = await connection.query<{ sessions: number; seals: number }>(
			`SELECT (SELECT count(*)::int FROM ${schema}.session WHERE user_id = $1) AS sessions,
			        (SELECT count(*)::int FROM ${schema}.security_state WHERE user_id = $1) AS seals`,
			[userId],
		);

		expect(sealed.leftUnsealed).toBe(true);
		expect(sealed.written.revokedCount).toBe(3);
		expect(left).toStrictEqual({ sessions: 0, seals: 0 });
	});
});
