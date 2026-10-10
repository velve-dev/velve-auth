import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TokenBindingRefusal } from "../src/core/token/binding.js";
import { rebindTokenRowsUnderCurrentKey } from "../src/core/token/rebind.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { testKeyRing } from "./totp-fixtures.js";

//a row the maintenance pass refuses tells the alarm which check it failed, and a row rewritten since its read keeps what was written (S-KEY-5)

let migrated: MigratedSchema;
let schema: string;
beforeAll(async () => {
	migrated = await openMigratedSchema("integ_token_rebind_verdicts");
	schema = migrated.schema;
});
afterAll(async () => {
	await dropSchema(migrated.connection, schema);
	await migrated.connection.close();
});

describe("a refused row in the maintenance pass names why", () => {
	it("a version that left the ring is key_version_unknown", async () => {
		const userId = await createUser(migrated.connection, schema);
		await migrated.connection.query(
			`INSERT INTO ${schema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at, factors, token_mac, token_mac_key_version)
			 VALUES ($1, $2, now() + interval '1 day', now() + interval '2 days', '{password}', $3, 7)`,
			[userId, randomBytes(32), randomBytes(32)],
		);
		const refusals: TokenBindingRefusal[] = [];

		const outcome = await rebindTokenRowsUnderCurrentKey({
			driver: migrated.connection,
			schema,
			keys: testKeyRing(2).providerAt(2, [1, 2]),
			sealing: "migrating",
			table: "session",
			batchSize: 10,
			reportTokenBindingRefusal: (refusal) => refusals.push(refusal),
		});

		expect(outcome.refused).toBe(1);
		expect(refusals).toStrictEqual([
			{
				userId,
				occasion: "maintenance",
				reason: "token_binding_mismatch",
				verdict: "key_version_unknown",
			},
		]);
	});
});

describe("the maintenance pass and a key that cannot take an HMAC", () => {
	it("refuses the row as key_unusable and does not rebind it", async () => {
		await migrated.connection.query(`DELETE FROM ${schema}.session`, []);
		const inner = testKeyRing(2).providerAt(2, [1, 2]);
		const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
			"encrypt",
		]);
		const keys = {
			current: (purpose: Parameters<typeof inner.current>[0]) => inner.current(purpose),
			byVersion: async (purpose: Parameters<typeof inner.byVersion>[0], version: number) =>
				purpose === "token-mac" && version === 7 ? aes : inner.byVersion(purpose, version),
		};
		const userId = await createUser(migrated.connection, schema);
		await migrated.connection.query(
			`INSERT INTO ${schema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at, factors, token_mac, token_mac_key_version)
			 VALUES ($1, $2, now() + interval '1 day', now() + interval '2 days', '{password}', $3, 7)`,
			[userId, randomBytes(32), randomBytes(32)],
		);
		const refusals: TokenBindingRefusal[] = [];

		const outcome = await rebindTokenRowsUnderCurrentKey({
			driver: migrated.connection,
			schema,
			keys,
			sealing: "migrating",
			table: "session",
			batchSize: 10,
			reportTokenBindingRefusal: (refusal) => refusals.push(refusal),
		});

		expect(outcome).toMatchObject({ rebound: 0, refused: 1 });
		expect(refusals.map((refusal) => refusal.verdict)).toStrictEqual(["key_unusable"]);
	});
});

describe("the maintenance pass and a row that is rewritten after it was read", () => {
	it("does not overwrite the MAC another writer put there", async () => {
		await migrated.connection.query(`DELETE FROM ${schema}.session`, []);
		const ring = testKeyRing(2);
		const { createSessionService } = await import("../src/core/session/service.js");
		const sessions = createSessionService({
			sealing: "migrating",
			driver: migrated.connection,
			keys: ring.providerAt(1, [1]),
			schema,
		});
		const userId = await createUser(migrated.connection, schema);
		await sessions.issue({
			authorisedBy: "unsealed",
			userId,
			factors: ["password"],
			observed: { ipAddress: null, userAgent: null },
		});
		const concurrent = randomBytes(32);
		let rewritten = false;
		const driver = {
			query: async <T>(sql: string, params: unknown[]) => {
				const rows = await migrated.connection.query<T>(sql, params);
				if (!rewritten && /token_mac_key_version <> \$1/.test(sql)) {
					rewritten = true;
					await migrated.connection.query(
						`UPDATE ${schema}.session SET token_mac = $1 WHERE user_id = $2`,
						[concurrent, userId],
					);
				}
				return rows;
			},
			transaction: migrated.connection.transaction.bind(migrated.connection),
		};

		const outcome = await rebindTokenRowsUnderCurrentKey({
			driver,
			schema,
			keys: ring.providerAt(2, [1, 2]),
			sealing: "migrating",
			table: "session",
			batchSize: 10,
		});

		const [row] = await migrated.connection.query<{ token_mac: Buffer }>(
			`SELECT token_mac FROM ${schema}.session WHERE user_id = $1`,
			[userId],
		);
		expect(rewritten).toBe(true);
		expect(outcome.rebound).toBe(0);
		expect(Buffer.from(row?.token_mac ?? []).equals(concurrent)).toBe(true);
	});
});
