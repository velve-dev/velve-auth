import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionService } from "../src/core/session/service.js";
import { testKeyProvider } from "./auth-fixtures.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";

//a row the library did not write is not counted by any revocation that removes several sessions at once (S-INTEG-9)

const OBSERVED = { ipAddress: null, userAgent: null };
const keys = testKeyProvider();
let migrated: MigratedSchema;
let schema: string;

beforeAll(async () => {
	migrated = await openMigratedSchema("integ_token_forged_row_revocations");
	schema = migrated.schema;
});
afterAll(async () => {
	await dropSchema(migrated.connection, schema);
	await migrated.connection.close();
});

async function plantedRow(userId: string): Promise<void> {
	await migrated.connection.query(
		`INSERT INTO ${schema}.session
		   (user_id, token_sha256, idle_expires_at, absolute_expires_at, factors, token_mac, token_mac_key_version)
		 VALUES ($1, $2, now() + interval '1 day', now() + interval '2 days', '{password}', $3, 1)`,
		[userId, createHash("sha256").update(randomBytes(8)).digest(), randomBytes(32)],
	);
}

describe("a planted session row", () => {
	it("is not counted by revokeEveryOther", async () => {
		const sessions = createSessionService({
			sealing: "migrating",
			driver: migrated.connection,
			keys,
			schema,
		});
		const userId = await createUser(migrated.connection, schema);
		const kept = await sessions.issue({
			authorisedBy: "unsealed",
			userId,
			factors: ["password"],
			observed: OBSERVED,
		});
		await sessions.issue({
			authorisedBy: "unsealed",
			userId,
			factors: ["password"],
			observed: OBSERVED,
		});
		await plantedRow(userId);
		const resolved = await sessions.resolve(kept.token);
		if (resolved === null) throw new Error("kept did not resolve");

		const answer = await sessions.revokeEveryOther({ resolved });

		expect(answer).toStrictEqual({ revokedCount: 1 });
	});

	it("is not counted by revokeEvery", async () => {
		const sessions = createSessionService({
			sealing: "migrating",
			driver: migrated.connection,
			keys,
			schema,
		});
		const userId = await createUser(migrated.connection, schema);
		const kept = await sessions.issue({
			authorisedBy: "unsealed",
			userId,
			factors: ["password"],
			observed: OBSERVED,
		});
		await plantedRow(userId);
		const resolved = await sessions.resolve(kept.token);
		if (resolved === null) throw new Error("kept did not resolve");

		expect(await sessions.revokeEvery({ resolved })).toStrictEqual({ revokedCount: 1 });
	});
});
