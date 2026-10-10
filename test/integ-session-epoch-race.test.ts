import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { lockAccountRowStatement } from "../src/core/db/lock.js";
import { createSessionService, type SessionService } from "../src/core/session/service.js";
import type { TokenBindingRefusal } from "../src/core/token/binding.js";
import { openConnectionPool } from "./connection-pool-fixtures.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { aFreshEpochOtherThan, authorisationOf } from "./session-fixtures.js";
import { testKeyRing } from "./totp-fixtures.js";

/**
 * Section 3.18 point 3: the session repository's own share of a mass revocation, with a
 * transaction of this test standing in for the revocation. The library's sign-in and resolution
 * racing `session.revokeAll` are in `test/security-state-revocation-race.test.ts` (E-3404).
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
		sealing: "migrating",
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
			`UPDATE ${schema}.security_state SET session_epoch = $2, version = version + 1
			 WHERE user_id = $1`,
			[userId, aFreshEpochOtherThan(1)],
		);
	});
}

//the writer acts on its own connection right after the issue has read the epoch it will bind
function writingAfterTheEpochRead(inner: Driver, write: () => Promise<unknown>): Driver {
	return {
		query: async <T>(sql: string, params: unknown[]) => {
			const rows = await inner.query<T>(sql, params);
			if (
				/^\s*SELECT\b.*\bsession_epoch\b.*\.security_state\b/s.test(sql) &&
				!sql.includes("token_sha256")
			) {
				await write();
			}
			return rows;
		},
		transaction: (work) => inner.transaction((tx) => work(writingAfterTheEpochRead(tx, write))),
	};
}

describe("a writer who changes the account's state between the epoch read and the insert (section 3.18 point 3)", () => {
	async function issueAround(userId: string, write: () => Promise<unknown>) {
		refusals = [];
		const racing = createSessionService({
			sealing: "migrating",
			driver: writingAfterTheEpochRead(migrated.connection, write),
			keys: testKeyRing(1).providerAt(1),
			schema,
			reportTokenBindingRefusal: (refusal) => refusals.push(refusal),
		});
		return racing
			.issueReplacingPresented({
				authorisedBy: "unsealed",
				completes: "password_sign_in",
				presentedToken: null,
				userId,
				factors: ["password"],
				observed: NO_REQUEST,
			})
			.then(() => "issued")
			.catch((failure: unknown) => failure);
	}

	async function sessionsOf(userId: string): Promise<number> {
		const [row] = await revoker.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM ${schema}.session WHERE user_id = $1`,
			[userId],
		);
		return row?.n ?? -1;
	}

	it("gets no session when the epoch rose, and raises seal_mismatch once", async () => {
		const userId = await sealedAccount();

		const outcome = await issueAround(userId, () =>
			revoker.query(`UPDATE ${schema}.security_state SET session_epoch = $2 WHERE user_id = $1`, [
				userId,
				aFreshEpochOtherThan(1),
			]),
		);

		expect(outcome).toMatchObject({ reason: "session_issue_missed_on_password_sign_in" });
		expect(await sessionsOf(userId)).toBe(0);
		expect(refusals).toStrictEqual([
			{ userId, occasion: "sign_in", reason: "seal_mismatch", verdict: "mismatch" },
		]);
	});

	it("gets no session when a seal row appeared for an account read without one", async () => {
		const userId = await createUser(migrated.connection, schema);

		const outcome = await issueAround(userId, () =>
			revoker.query(
				`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
				 VALUES ($1, 1, $2, 1)`,
				[userId, randomBytes(32)],
			),
		);

		expect(outcome).toMatchObject({ reason: "session_issue_missed_on_password_sign_in" });
		expect(await sessionsOf(userId)).toBe(0);
		expect(refusals.map((refusal) => refusal.reason)).toStrictEqual(["seal_mismatch"]);
	});
});

describe("signing out every other session (section 3.18 point 3)", () => {
	const keys = testKeyRing(1).providerAt(1);

	function serviceOver(driver: Driver) {
		return createSessionService({
			sealing: "migrating",
			driver,
			keys,
			schema,
			reportTokenBindingRefusal: (refusal) => refusals.push(refusal),
		});
	}

	async function signedInTwice(service: SessionService, userId: string) {
		const kept = await service.issue({
			authorisedBy: await authorisationOf(migrated.connection, schema, userId),
			userId,
			factors: ["password"],
			observed: NO_REQUEST,
		});
		const other = await service.issue({
			authorisedBy: await authorisationOf(migrated.connection, schema, userId),
			userId,
			factors: ["password"],
			observed: NO_REQUEST,
		});
		const resolved = await service.resolve(kept.token);
		if (resolved === null) {
			throw new Error("the kept session did not resolve");
		}
		return { kept, other, resolved };
	}

	it("waits for the account lock, keeps the caller's session and counts the other", async () => {
		const service = serviceOver(pool);
		const userId = await sealedAccount();
		const { kept, other, resolved } = await signedInTwice(service, userId);
		refusals = [];
		await revoker.query("BEGIN", []);
		await revoker.query(lockAccountRowStatement(schema), [userId]);

		const revoking = service.revokeEveryOther({ resolved });
		const finishedBeforeCommit = await Promise.race([
			revoking.then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 400)),
		]);
		await revoker.query("COMMIT", []);

		expect(finishedBeforeCommit).toBe(false);
		expect(await revoking).toStrictEqual({ revokedCount: 1 });
		expect((await service.resolve(kept.token))?.userId).toBe(userId);
		expect(await service.resolve(other.token)).toBeNull();
		expect(refusals).toStrictEqual([]);
	});

	it("signs the caller out too, with the alarm, when the kept row no longer holds the MAC it was read with", async () => {
		const userId = await sealedAccount();
		let rewritten = false;
		const rewritingAfterTheKeptRead: Driver = {
			query: (sql, params) => pool.query(sql, params),
			transaction: (work) =>
				pool.transaction((tx) =>
					work({
						query: async <T>(sql: string, parameters: unknown[]) => {
							const rows = await tx.query<T>(sql, parameters);
							if (
								!rewritten &&
								/^SELECT s\.id, s\.user_id/.test(sql.trim()) &&
								sql.includes("s.id = $1 AND s.user_id = $2")
							) {
								rewritten = true;
								await revoker.query(`UPDATE ${schema}.session SET token_mac = $2 WHERE id = $1`, [
									parameters[0],
									randomBytes(32),
								]);
							}
							return rows;
						},
						transaction: tx.transaction,
					}),
				),
		};
		const service = serviceOver(rewritingAfterTheKeptRead);
		const { kept, resolved } = await signedInTwice(serviceOver(pool), userId);
		refusals = [];

		const answer = await service.revokeEveryOther({ resolved });

		expect(rewritten).toBe(true);
		expect(answer).toStrictEqual({ revokedCount: 1 });
		expect(await serviceOver(pool).resolve(kept.token)).toBeNull();
		expect(refusals.filter((refusal) => refusal.occasion === "change")).toStrictEqual([
			{ userId, occasion: "change", reason: "token_binding_mismatch", verdict: "mismatch" },
		]);
	});

	it("signs the caller out too, with the alarm, when the kept row fails its check under the lock", async () => {
		const service = serviceOver(pool);
		const userId = await sealedAccount();
		const { kept, resolved } = await signedInTwice(service, userId);
		await revoker.query(`UPDATE ${schema}.session SET factors = '{password,totp}' WHERE id = $1`, [
			kept.session.id,
		]);
		refusals = [];

		await service.revokeEveryOther({ resolved });
		const [left] = await revoker.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM ${schema}.session WHERE user_id = $1`,
			[userId],
		);

		expect(left?.n).toBe(0);
		expect(refusals.map((refusal) => refusal.reason)).toStrictEqual(["token_binding_mismatch"]);
	});
});

describe("a resolve racing a mass revocation (section 3.18 point 3, S-CACHE-2)", () => {
	it(`reads the row and the epoch in one statement and raises no alarm in ${PAIRS} races`, async () => {
		refusals = [];
		for (let pair = 0; pair < PAIRS; pair += 1) {
			const userId = await sealedAccount();
			const issued = await sessions.issue({
				authorisedBy: await authorisationOf(migrated.connection, schema, userId),
				userId,
				factors: ["password"],
				observed: NO_REQUEST,
			});
			await Promise.all([sessions.resolve(issued.token), revokeEverySession(pool, userId)]);
		}

		expect(refusals).toStrictEqual([]);
	});
});
