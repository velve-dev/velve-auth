import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { lockAccountRowStatement } from "../src/core/db/lock.js";
import { createSessionService, type SessionService } from "../src/core/session/service.js";
import type { TokenBindingRefusal } from "../src/core/token/binding.js";
import { openConnectionPool } from "./connection-pool-fixtures.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { testKeyRing } from "./totp-fixtures.js";

/**
 * Section 3.18 point 3 and T-INTEG-3: a sign-in racing a mass revocation raises no alarm, and every
 * session whose row exists after the revocation resolves. Raising the epoch is the seal branch's,
 * so a transaction of this test stands in for the revocation: account lock, delete every session,
 * raise the epoch, commit. Issuing takes the account lock first (E-3141), so it waits for the
 * revocation and binds the epoch the revocation leaves.
 */

const NO_REQUEST = { ipAddress: null, userAgent: null };
const PAIRS = 50;

let migrated: MigratedSchema;
let schema: string;
let pool: Awaited<ReturnType<typeof openConnectionPool>>;
let revoker: TestConnection;
let refusals: TokenBindingRefusal[];
let sessions: SessionService;

beforeAll(async () => {
	migrated = await openMigratedSchema("session_epoch_race");
	schema = migrated.schema;
	pool = await openConnectionPool(8);
	revoker = await openTestConnection();
	sessions = createSessionService({
		driver: pool,
		keys: testKeyRing(1).providerAt(1),
		schema,
		reportTokenBindingRefusal: (refusal) => refusals.push(refusal),
	});
}, 60_000);

afterAll(async () => {
	await revoker.close();
	await pool.close();
	await dropSchema(migrated.connection, schema);
	await migrated.connection.close();
});

async function sealedAccount(): Promise<string> {
	const userId = await createUser(migrated.connection, schema);
	await migrated.connection.query(
		`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
		 VALUES ($1, 1, $2, 1)`,
		[userId, randomBytes(32)],
	);
	return userId;
}

async function revokeEverySession(driver: Driver, userId: string): Promise<void> {
	await driver.transaction(async (tx) => {
		await tx.query(lockAccountRowStatement(schema), [userId]);
		await tx.query(`DELETE FROM ${schema}.session WHERE user_id = $1`, [userId]);
		await tx.query(
			`UPDATE ${schema}.security_state SET session_epoch = session_epoch + 1, version = version + 1
			 WHERE user_id = $1`,
			[userId],
		);
	});
}

async function tokensThatSurvived(userId: string, tokens: readonly string[]): Promise<string[]> {
	const surviving: string[] = [];
	for (const token of tokens) {
		const [row] = await migrated.connection.query<{ present: number }>(
			`SELECT count(*)::int AS present FROM ${schema}.session
			 WHERE user_id = $1 AND token_sha256 = sha256(convert_to($2, 'UTF8'))`,
			[userId, token],
		);
		if (row?.present === 1) {
			surviving.push(token);
		}
	}
	return surviving;
}

describe("a sign-in racing a mass revocation (section 3.18 point 3, T-INTEG-3)", () => {
	it("waits for the revocation's commit and binds the epoch it leaves", async () => {
		const userId = await sealedAccount();
		refusals = [];

		await revoker.query("BEGIN", []);
		await revoker.query(lockAccountRowStatement(schema), [userId]);
		await revoker.query(`DELETE FROM ${schema}.session WHERE user_id = $1`, [userId]);
		await revoker.query(
			`UPDATE ${schema}.security_state SET session_epoch = session_epoch + 1 WHERE user_id = $1`,
			[userId],
		);
		const issuing = sessions.issue({ userId, factors: ["password"], observed: NO_REQUEST });
		const finishedBeforeCommit = await Promise.race([
			issuing.then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
		]);
		await revoker.query("COMMIT", []);
		const issued = await issuing;

		expect(finishedBeforeCommit).toBe(false);
		expect((await sessions.resolve(issued.token))?.userId).toBe(userId);
		expect(refusals).toStrictEqual([]);
	});

	it(`leaves every surviving session resolvable and raises no alarm in ${PAIRS} races`, async () => {
		refusals = [];
		let surviving = 0;
		for (let pair = 0; pair < PAIRS; pair += 1) {
			const userId = await sealedAccount();
			const [issued] = await Promise.all([
				sessions.issue({ userId, factors: ["password"], observed: NO_REQUEST }),
				revokeEverySession(pool, userId),
			]);
			for (const token of await tokensThatSurvived(userId, [issued.token])) {
				surviving += 1;
				expect((await sessions.resolve(token))?.userId).toBe(userId);
			}
		}

		expect(surviving).toBeGreaterThan(0);
		expect(refusals).toStrictEqual([]);
	});
});
