import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { createOneTimeTokenRepository } from "../src/core/db/repositories/token.js";
import { bookAttemptOn } from "../src/core/factor/pending/booking.js";
import { createPendingAuthenticationService } from "../src/core/factor/pending/index.js";
import { createWebAuthnChallenges } from "../src/core/factor/webauthn/challenge.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { createSessionService } from "../src/core/session/service.js";
import type { TokenBindingRefusal } from "../src/core/token/binding.js";
import { createOneTimeTokens } from "../src/core/token/one-time-token.js";
import { rebindTokenRowsUnderCurrentKey, type TokenTable } from "../src/core/token/rebind.js";
import { toSecretToken } from "../src/core/token/secret-token.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { testKeyRing } from "./totp-fixtures.js";

/**
 * S-KEY-5 and section 3.18 point 3: the maintenance step rebinds the token rows no resolve has
 * rebound before the old token-mac version leaves the ring, in all four token tables, and checks
 * every row under its own version first. This is the seam it calls (E-3148, E-3266).
 */

const NO_REQUEST = { ipAddress: null, userAgent: null };
const BATCH = 2;

let migrated: MigratedSchema;
let schema: string;
let refusals: TokenBindingRefusal[];

function servicesUnder(keys: KeyProvider) {
	const report = (refusal: TokenBindingRefusal) => refusals.push(refusal);
	return {
		sessions: createSessionService({
			driver: migrated.connection,
			keys,
			sealing: "migrating",
			schema,
			reportTokenBindingRefusal: report,
		}),
		pending: createPendingAuthenticationService({
			driver: migrated.connection,
			keys,
			schema,
			reportTokenBindingRefusal: report,
		}),
		tokens: createOneTimeTokens(
			createOneTimeTokenRepository({ driver: migrated.connection, schema }),
			{ keys, reportTokenBindingRefusal: report },
		),
		challenges: createWebAuthnChallenges({
			driver: migrated.connection,
			schema,
			keys,
			reportTokenBindingRefusal: report,
		}),
	};
}

function rebind(keys: KeyProvider, table: TokenTable) {
	return rebindTokenRowsUnderCurrentKey({
		driver: migrated.connection,
		schema,
		keys,
		sealing: "migrating",
		table,
		batchSize: BATCH,
		reportTokenBindingRefusal: (refusal) => refusals.push(refusal),
	});
}

beforeAll(async () => {
	migrated = await openMigratedSchema("token_rebind");
	schema = migrated.schema;
});

afterAll(async () => {
	await dropSchema(migrated.connection, schema);
	await migrated.connection.close();
});

const EVERY_TABLE: readonly TokenTable[] = [
	"session",
	"one_time_token",
	"pending_authentication",
	"webauthn_challenge",
];

function sha256Of(token: string): Buffer {
	return createHash("sha256").update(token, "utf8").digest();
}

async function emptyTokenTables(): Promise<void> {
	for (const table of EVERY_TABLE) {
		await migrated.connection.query(`DELETE FROM ${schema}.${table}`, []);
	}
}

describe("rebinding token rows no resolve has rebound (S-KEY-5)", () => {
	it("rebinds every table in batches, so every row works once the old version has left", async () => {
		await emptyTokenTables();
		const ring = testKeyRing(2);
		const before = servicesUnder(ring.providerAt(1, [1]));
		const rotatedKeys = ring.providerAt(2, [1, 2]);
		const after = servicesUnder(ring.providerAt(2, [2]));
		const userId = await createUser(migrated.connection, schema);
		const sessionTokens = [];
		for (let index = 0; index < 3; index += 1) {
			sessionTokens.push(
				(await before.sessions.issue({ userId, factors: ["password"], observed: NO_REQUEST }))
					.token,
			);
		}
		const pendingToken = (await before.pending.begin({ userId, factorsCompleted: ["password"] }))
			.token;
		const oneTime = (await before.tokens.issue({ purpose: "magic_link", userId })).token;
		const cover = await before.tokens.issue({
			purpose: "password_reset",
			userId: null,
			serialisedOn: "nobody@example.com",
		});
		const challenge = await before.challenges.issue({ purpose: "authenticate", userId: null });
		refusals = [];

		const results: Record<string, unknown> = {};
		for (const table of EVERY_TABLE) {
			results[table] = await rebind(rotatedKeys, table);
		}

		expect(results).toStrictEqual({
			session: { rebound: 3, refused: 0, rowsByKeyVersion: { 2: { tokens: 3, traces: 0 } } },
			one_time_token: { rebound: 2, refused: 0, rowsByKeyVersion: { 2: { tokens: 2, traces: 0 } } },
			pending_authentication: {
				rebound: 1,
				refused: 0,
				rowsByKeyVersion: { 2: { tokens: 1, traces: 0 } },
			},
			webauthn_challenge: {
				rebound: 1,
				refused: 0,
				rowsByKeyVersion: { 2: { tokens: 1, traces: 0 } },
			},
		});
		expect(refusals).toStrictEqual([]);
		for (const token of sessionTokens) {
			expect((await after.sessions.resolve(token))?.userId).toBe(userId);
		}
		expect((await bookAttemptOn(after.pending, pendingToken)).outcome).toBe("booked");
		expect(
			await after.tokens.redeem({ token: toSecretToken(oneTime), purpose: "magic_link" }),
		).toMatchObject({ userId });
		expect(await after.tokens.redeem({ token: cover.token, purpose: "password_reset" })).toBeNull();
		expect(
			await after.challenges.consume({
				challengeToken: challenge.challengeToken,
				purpose: "authenticate",
				userId: null,
			}),
		).toBe(true);
		expect(refusals).toStrictEqual([]);
	});

	it("leaves a forged session and one-time token under the old version unusable, one report each", async () => {
		await emptyTokenTables();
		const ring = testKeyRing(2);
		const rotatedKeys = ring.providerAt(2, [1, 2]);
		const after = servicesUnder(ring.providerAt(2, [1, 2]));
		const userId = await createUser(migrated.connection, schema);
		const forgedSession = randomBytes(32).toString("base64url");
		const forgedOneTime = randomBytes(32).toString("base64url");
		await migrated.connection.query(
			`INSERT INTO ${schema}.session
			   (user_id, token_sha256, idle_expires_at, absolute_expires_at, factors,
			    token_mac, token_mac_key_version)
			 VALUES ($1, $2, now() + interval '1 day', now() + interval '2 days', '{password}', $3, 1)`,
			[userId, sha256Of(forgedSession), randomBytes(32)],
		);
		await migrated.connection.query(
			`INSERT INTO ${schema}.one_time_token
			   (token_sha256, purpose, user_id, payload, expires_at, token_mac, token_mac_key_version)
			 VALUES ($1, 'magic_link', $2, NULL, now() + interval '1 hour', $3, 1)`,
			[sha256Of(forgedOneTime), userId, randomBytes(32)],
		);
		refusals = [];

		const session = await rebind(rotatedKeys, "session");
		const oneTime = await rebind(rotatedKeys, "one_time_token");

		expect(session).toStrictEqual({
			rebound: 0,
			refused: 1,
			rowsByKeyVersion: { 1: { tokens: 0, traces: 1 } },
		});
		expect(oneTime).toStrictEqual({
			rebound: 0,
			refused: 1,
			rowsByKeyVersion: { 1: { tokens: 0, traces: 1 } },
		});
		expect(refusals).toStrictEqual([
			{ userId, occasion: "maintenance", reason: "token_binding_mismatch", verdict: "mismatch" },
			{ userId, occasion: "maintenance", reason: "token_binding_mismatch", verdict: "mismatch" },
		]);
		expect(await after.sessions.resolve(forgedSession)).toBeNull();
		expect(
			await after.tokens.redeem({ token: toSecretToken(forgedOneTime), purpose: "magic_link" }),
		).toBeNull();
	});

	it("rebinds a pending row only where its counter has not moved since it was read", async () => {
		await emptyTokenTables();
		const ring = testKeyRing(2);
		const before = servicesUnder(ring.providerAt(1, [1]));
		const userId = await createUser(migrated.connection, schema);
		const { token } = await before.pending.begin({ userId, factorsCompleted: ["password"] });
		let booked = false;
		const bookingBeforeTheRebinding = {
			query: async <T>(sql: string, params: unknown[]) => {
				if (!booked && sql.includes("UPDATE") && sql.includes("AND attempts = $7")) {
					booked = true;
					await bookAttemptOn(before.pending, token);
				}
				return migrated.connection.query<T>(sql, params);
			},
			transaction<T>(work: (tx: Driver) => Promise<T>): Promise<T> {
				return work(this);
			},
		};
		refusals = [];

		const pass = await rebindTokenRowsUnderCurrentKey({
			driver: bookingBeforeTheRebinding,
			schema,
			keys: ring.providerAt(2, [1, 2]),
			sealing: "migrating",
			table: "pending_authentication",
			batchSize: BATCH,
			reportTokenBindingRefusal: (refusal) => refusals.push(refusal),
		});
		const [row] = await migrated.connection.query<{ attempts: number; version: number }>(
			`SELECT attempts, token_mac_key_version AS version FROM ${schema}.pending_authentication
			 WHERE user_id = $1`,
			[userId],
		);

		expect(booked).toBe(true);
		expect(pass).toStrictEqual({
			rebound: 0,
			refused: 0,
			rowsByKeyVersion: { 1: { tokens: 1, traces: 0 } },
		});
		expect(row).toStrictEqual({ attempts: 1, version: 1 });
		expect(refusals).toStrictEqual([]);
	});

	it("lets a booking that meets a row the maintenance rebound at the same count go on without an alarm", async () => {
		await emptyTokenTables();
		const ring = testKeyRing(2);
		const before = servicesUnder(ring.providerAt(1, [1]));
		const rotatedKeys = ring.providerAt(2, [1, 2]);
		const userId = await createUser(migrated.connection, schema);
		const { token } = await before.pending.begin({ userId, factorsCompleted: ["password"] });
		let rebound = false;
		const rebindingBeforeTheBooking = {
			query: async <T>(sql: string, params: unknown[]) => {
				if (!rebound && sql.includes("SET attempts =")) {
					rebound = true;
					await rebind(rotatedKeys, "pending_authentication");
				}
				return migrated.connection.query<T>(sql, params);
			},
			transaction<T>(work: (tx: Driver) => Promise<T>): Promise<T> {
				return work(this);
			},
		};
		const booking = createPendingAuthenticationService({
			driver: rebindingBeforeTheBooking,
			keys: rotatedKeys,
			schema,
			reportTokenBindingRefusal: (refusal) => refusals.push(refusal),
		});
		refusals = [];

		const outcome = (await bookAttemptOn(booking, token)).outcome;
		const [row] = await migrated.connection.query<{ attempts: number; version: number }>(
			`SELECT attempts, token_mac_key_version AS version FROM ${schema}.pending_authentication
			 WHERE user_id = $1`,
			[userId],
		);

		expect(rebound).toBe(true);
		expect(outcome).toBe("booked");
		expect(row).toStrictEqual({ attempts: 1, version: 2 });
		expect(refusals).toStrictEqual([]);
	});

	it("leaves a row whose key version a writer changed between the read and the rebinding", async () => {
		await emptyTokenTables();
		const ring = testKeyRing(2);
		const before = servicesUnder(ring.providerAt(1, [1]));
		const userId = await createUser(migrated.connection, schema);
		await before.sessions.issue({ userId, factors: ["password"], observed: NO_REQUEST });
		let moved = false;
		const movingTheVersion = {
			query: async <T>(sql: string, params: unknown[]) => {
				if (
					!moved &&
					sql.trimStart().startsWith("UPDATE") &&
					sql.includes("RETURNING token_sha256")
				) {
					moved = true;
					await migrated.connection.query(
						`UPDATE ${schema}.session SET token_mac_key_version = 7 WHERE user_id = $1`,
						[userId],
					);
				}
				return migrated.connection.query<T>(sql, params);
			},
			transaction<T>(work: (tx: Driver) => Promise<T>): Promise<T> {
				return work(this);
			},
		};

		const pass = await rebindTokenRowsUnderCurrentKey({
			driver: movingTheVersion,
			schema,
			keys: ring.providerAt(2, [1, 2]),
			sealing: "migrating",
			table: "session",
			batchSize: BATCH,
		});

		expect(moved).toBe(true);
		expect(pass).toStrictEqual({
			rebound: 0,
			refused: 0,
			rowsByKeyVersion: { 7: { tokens: 1, traces: 0 } },
		});
	});
});

describe("the rows a pass reports under each key version (S-KEY-5, E-3277)", () => {
	it("counts a forged row under the old version as a trace, which is refused once the version has left", async () => {
		await emptyTokenTables();
		const ring = testKeyRing(2);
		const before = servicesUnder(ring.providerAt(1, [1]));
		const userId = await createUser(migrated.connection, schema);
		const genuine = await before.sessions.issue({
			userId,
			factors: ["password"],
			observed: NO_REQUEST,
		});
		const forged = randomBytes(32).toString("base64url");
		await migrated.connection.query(
			`INSERT INTO ${schema}.session
			   (user_id, token_sha256, idle_expires_at, absolute_expires_at, factors,
			    token_mac, token_mac_key_version)
			 VALUES ($1, $2, now() + interval '1 day', now() + interval '2 days', '{password}', $3, 1)`,
			[userId, sha256Of(forged), randomBytes(32)],
		);
		refusals = [];

		const pass = await rebind(ring.providerAt(2, [1, 2]), "session");
		const removed = servicesUnder(ring.providerAt(2, [2]));
		refusals = [];

		expect(pass).toStrictEqual({
			rebound: 1,
			refused: 1,
			rowsByKeyVersion: { 1: { tokens: 0, traces: 1 }, 2: { tokens: 1, traces: 0 } },
		});
		expect(await removed.sessions.resolve(genuine.token)).not.toBeNull();
		expect(await removed.sessions.resolve(forged)).toBeNull();
		expect(refusals.map((refusal) => refusal.verdict)).toStrictEqual(["key_version_unknown"]);
	});

	it("counts a refused row a writer rewrote after the refusal as a token again", async () => {
		await emptyTokenTables();
		const ring = testKeyRing(2);
		const userId = await createUser(migrated.connection, schema);
		const forged = randomBytes(32).toString("base64url");
		await migrated.connection.query(
			`INSERT INTO ${schema}.session
			   (user_id, token_sha256, idle_expires_at, absolute_expires_at, factors,
			    token_mac, token_mac_key_version)
			 VALUES ($1, $2, now() + interval '1 day', now() + interval '2 days', '{password}', $3, 1)`,
			[userId, sha256Of(forged), randomBytes(32)],
		);
		const rewriting = {
			transaction<T>(work: (tx: Driver) => Promise<T>): Promise<T> {
				return work(this);
			},
			query: async <T>(sql: string, params: unknown[]): Promise<T[]> => {
				if (sql.includes("WITH trace AS")) {
					await migrated.connection.query(
						`UPDATE ${schema}.session SET token_mac = $2 WHERE token_sha256 = $1`,
						[sha256Of(forged), randomBytes(32)],
					);
				}
				return migrated.connection.query<T>(sql, params);
			},
		};
		refusals = [];

		const pass = await rebindTokenRowsUnderCurrentKey({
			driver: rewriting,
			schema,
			keys: ring.providerAt(2, [1, 2]),
			sealing: "migrating",
			table: "session",
			batchSize: BATCH,
		});

		expect(pass.rowsByKeyVersion).toStrictEqual({ 1: { tokens: 1, traces: 0 } });
	});
});
