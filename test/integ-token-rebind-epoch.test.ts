import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { createSessionService } from "../src/core/session/service.js";
import { rebindTokenRowsUnderCurrentKey } from "../src/core/token/rebind.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { aFreshEpochOtherThan, authorisationOf } from "./session-fixtures.js";
import { testKeyRing } from "./totp-fixtures.js";

// S-KEY-5 with S-INTEG-9: a session of an account above epoch 1 that resolves under a newer key
// version is rebound over its own epoch, and goes on resolving. A caller that names a factor
// twice gets the one session the row stores.

const NO_REQUEST = { ipAddress: null, userAgent: null };

let migrated: MigratedSchema;
let schema: string;

beforeAll(async () => {
	migrated = await openMigratedSchema("review_rebind_epoch");
	schema = migrated.schema;
});

afterAll(async () => {
	await dropSchema(migrated.connection, schema);
	await migrated.connection.close();
});

describe("a rebound session keeps the epoch it was issued under", () => {
	it("resolves again after the resolve that rebound it, at epoch 3", async () => {
		const ring = testKeyRing(2);
		const serviceAt = (current: number, available: number[]) =>
			createSessionService({
				sealing: "migrating",
				driver: migrated.connection,
				keys: ring.providerAt(current, available),
				schema,
			});
		const before = serviceAt(1, [1]);
		const rotated = serviceAt(2, [1, 2]);
		const userId = await createUser(migrated.connection, schema);
		await migrated.connection.query(
			`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version, session_epoch)
			 VALUES ($1, 3, $2, 1, $3)`,
			[userId, randomBytes(32), aFreshEpochOtherThan(1)],
		);
		const issued = await before.issue({
			authorisedBy: await authorisationOf(migrated.connection, schema, userId),
			userId,
			factors: ["password"],
			observed: NO_REQUEST,
		});

		const first = await rotated.resolve(issued.token);
		const second = await rotated.resolve(issued.token);
		const [row] = await migrated.connection.query<{ version: number }>(
			`SELECT token_mac_key_version AS version FROM ${schema}.session WHERE id = $1`,
			[issued.session.id],
		);

		expect(first?.userId).toBe(userId);
		expect(row?.version).toBe(2);
		expect(second?.userId).toBe(userId);
	});
});

describe("a session issued with a factor named twice", () => {
	it("resolves, because the MAC covers the factors the row stores", async () => {
		const service = createSessionService({
			sealing: "migrating",
			driver: migrated.connection,
			keys: testKeyRing(1).providerAt(1),
			schema,
		});
		const userId = await createUser(migrated.connection, schema);

		const issued = await service.issue({
			authorisedBy: await authorisationOf(migrated.connection, schema, userId),
			userId,
			factors: ["password", "password"],
			observed: NO_REQUEST,
		});

		expect((await service.resolve(issued.token))?.userId).toBe(userId);
	});
});

describe('the maintenance rebinding of a session of an account without a seal row in "required"', () => {
	it("refuses it and reports it, and rebinds nothing", async () => {
		const ring = testKeyRing(2);
		const refusals: unknown[] = [];
		const before = createSessionService({
			sealing: "migrating",
			driver: migrated.connection,
			keys: ring.providerAt(1, [1]),
			schema,
		});
		const userId = await createUser(migrated.connection, schema);
		await before.issue({
			authorisedBy: await authorisationOf(migrated.connection, schema, userId),
			userId,
			factors: ["password"],
			observed: NO_REQUEST,
		});

		const pass = await rebindTokenRowsUnderCurrentKey({
			driver: migrated.connection,
			schema,
			keys: ring.providerAt(2, [1, 2]),
			sealing: "required",
			table: "session",
			batchSize: 100,
			reportTokenBindingRefusal: (refusal) => refusals.push(refusal),
		});

		expect(pass.rebound).toBe(0);
		expect(pass.refused).toBeGreaterThanOrEqual(1);
		expect(refusals.length).toBeGreaterThanOrEqual(1);
	});
});

describe("a one-time token whose payload jsonb stores differently from how it was written", () => {
	it("redeems when the payload has an undefined member, an exponent number and nested arrays", async () => {
		const { createOneTimeTokenRepository } = await import("../src/core/db/repositories/token.js");
		const { createOneTimeTokens } = await import("../src/core/token/one-time-token.js");
		const { toSecretToken } = await import("../src/core/token/secret-token.js");
		const tokens = createOneTimeTokens(
			createOneTimeTokenRepository({ driver: migrated.connection, schema }),
			{ keys: testKeyRing(1).providerAt(1) },
		);
		const userId = await createUser(migrated.connection, schema);
		const payload = { b: [3, { z: 1, a: undefined }], a: 1e21, c: "x" };

		const { token } = await tokens.issue({ purpose: "email_change", userId, payload });
		const redeemed = await tokens.redeem({ token: toSecretToken(token), purpose: "email_change" });

		expect(redeemed?.userId).toBe(userId);
	});
});

describe("the maintenance rebinding against a mass revocation (section 3.18 point 5, E-3277)", () => {
	it("reads the session and the account's epoch in one statement, so a revocation after it raises nothing", async () => {
		const ring = testKeyRing(2);
		await migrated.connection.query(`DELETE FROM ${schema}.session`, []);
		const before = createSessionService({
			sealing: "migrating",
			driver: migrated.connection,
			keys: ring.providerAt(1, [1]),
			schema,
		});
		const userId = await createUser(migrated.connection, schema);
		await migrated.connection.query(
			`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version, session_epoch)
			 VALUES ($1, 1, $2, 1, $3)`,
			[userId, randomBytes(32), aFreshEpochOtherThan(1)],
		);
		await before.issue({
			authorisedBy: await authorisationOf(migrated.connection, schema, userId),
			userId,
			factors: ["password"],
			observed: NO_REQUEST,
		});
		const reads: string[] = [];
		let revoked = false;
		const revokingAfterTheRead = {
			transaction<T>(work: (tx: Driver) => Promise<T>): Promise<T> {
				return work(this);
			},
			query: async <T>(sql: string, params: unknown[]): Promise<T[]> => {
				const rows = await migrated.connection.query<T>(sql, params);
				if (!revoked && /token_mac_key_version <> \$1/.test(sql)) {
					revoked = true;
					reads.push(sql);
					await migrated.connection.query(`DELETE FROM ${schema}.session WHERE user_id = $1`, [
						userId,
					]);
					await migrated.connection.query(
						`UPDATE ${schema}.security_state SET session_epoch = $2 WHERE user_id = $1`,
						[userId, aFreshEpochOtherThan(1)],
					);
				}
				return rows;
			},
		};
		const refusals: unknown[] = [];

		const pass = await rebindTokenRowsUnderCurrentKey({
			driver: revokingAfterTheRead,
			schema,
			keys: ring.providerAt(2, [1, 2]),
			sealing: "migrating",
			table: "session",
			batchSize: 100,
			reportTokenBindingRefusal: (refusal) => refusals.push(refusal),
		});

		expect(reads[0]).toMatch(/SELECT session_epoch FROM \S+\.security_state/);
		expect({ revoked, rebound: pass.rebound, refused: pass.refused, refusals }).toStrictEqual({
			revoked: true,
			rebound: 0,
			refused: 0,
			refusals: [],
		});
	});
});
