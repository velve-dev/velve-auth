import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOneTimeTokenRepository } from "../src/core/db/repositories/token.js";
import { createPendingAuthenticationService } from "../src/core/factor/pending/index.js";
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
 * rebound before the old token-mac version leaves the ring. This is the seam it calls (E-3148).
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

describe("rebinding token rows no resolve has rebound (S-KEY-5)", () => {
	it("rebinds every row of the three tables in batches, refuses a forged one, and survives the old version leaving", async () => {
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
		const forged = randomBytes(32).toString("base64url");
		await migrated.connection.query(
			`INSERT INTO ${schema}.session
			   (user_id, token_sha256, idle_expires_at, absolute_expires_at, factors,
			    token_mac, token_mac_key_version)
			 VALUES ($1, $2, now() + interval '1 day', now() + interval '2 days', '{password}', $3, 1)`,
			[userId, createHash("sha256").update(forged, "utf8").digest(), randomBytes(32)],
		);
		refusals = [];

		const results = {
			session: await rebind(rotatedKeys, "session"),
			pending: await rebind(rotatedKeys, "pending_authentication"),
			oneTime: await rebind(rotatedKeys, "one_time_token"),
			again: await rebind(rotatedKeys, "session"),
		};

		expect(results).toStrictEqual({
			session: { rebound: 3, refused: 1 },
			pending: { rebound: 1, refused: 0 },
			oneTime: { rebound: 1, refused: 0 },
			again: { rebound: 0, refused: 1 },
		});
		expect(refusals.map((refusal) => [refusal.occasion, refusal.reason])).toStrictEqual([
			["maintenance", "token_binding_mismatch"],
			["maintenance", "token_binding_mismatch"],
		]);
		refusals = [];
		for (const token of sessionTokens) {
			expect((await after.sessions.resolve(token))?.userId).toBe(userId);
		}
		expect((await after.pending.resolve(pendingToken))?.userId).toBe(userId);
		expect(
			await after.tokens.redeem({ token: toSecretToken(oneTime), purpose: "magic_link" }),
		).toMatchObject({ userId });
		expect(await after.sessions.resolve(forged)).toBeNull();
	});
});
