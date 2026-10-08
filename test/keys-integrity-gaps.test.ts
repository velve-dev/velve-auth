import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertStoredIntegrityKeysTakeMac } from "../src/core/auth/integrity-key-ring.js";
import { assertKeysAnswerForEveryPurpose } from "../src/core/auth/startup.js";
import type { Driver } from "../src/core/db/driver.js";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import { sameKeyFingerprintOf } from "../src/core/keys/mac.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { rootKeyProvider } from "../src/core/keys/root-key-provider.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { generateRootKey } from "./keys-fixtures.js";
import {
	asTheMigrationRole,
	createTheMigrationRole,
	dropTheMigrationRole,
} from "./plugin-fixtures.js";

//plugin migrations state read committed and the start and probe guards hold against their planted faults (E-3370)

const genuine = rootKeyProvider({
	currentVersion: 1,
	keysByVersion: { 1: generateRootKey() },
});

describe("the read-committed wrapper and the key guards", () => {
	it("a plugin migration's transactions state READ COMMITTED too", async () => {
		const { connection: owner, schema } = await openMigratedSchema("gaps_owned_migration");
		const role = await createTheMigrationRole(owner, schema);
		const firsts: string[] = [];
		try {
			await asTheMigrationRole(role, async (migrator) => {
				const recording: Driver = {
					query: (sql, params) => migrator.query(sql, params),
					transaction: (work) =>
						migrator.transaction((tx) => {
							let first = true;
							return work({
								query: (sql, params) => {
									if (first) {
										firsts.push(sql.trim().split(/\s+/).slice(0, 5).join(" "));
										first = false;
									}
									return tx.query(sql, params);
								},
								transaction: (inner) => tx.transaction(inner),
							});
						}),
				};
				await runMigrations({
					driver: recording,
					schema,
					migrations: [
						...coreMigrations("email"),
						{
							version: 1,
							name: "create_audit_entry",
							owner: "audit",
							createsTables: ["audit_entry"],
							sql: `CREATE TABLE velve.audit_entry (
								id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
								user_id uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
								note text NOT NULL
							);`,
						},
					],
				});
			});
		} finally {
			await dropSchema(owner, schema);
			await dropTheMigrationRole(owner, role);
			await owner.close();
		}
		expect(firsts.length).toBeGreaterThan(4);
		expect(firsts.filter((sql) => !sql.startsWith("SET TRANSACTION ISOLATION LEVEL READ"))).toEqual(
			[],
		);
	});

	it("a provider whose current() rejects refuses the start with keys_unusable", async () => {
		const provider: KeyProvider = {
			current: (purpose) =>
				purpose === "pkce-enc" ? Promise.reject(new Error("boom")) : genuine.current(purpose),
			byVersion: (purpose, version) => genuine.byVersion(purpose, version),
		};
		await expect(assertKeysAnswerForEveryPurpose(provider)).rejects.toMatchObject({
			code: "keys_unusable",
		});
	});

	it("an HMAC-looking value without usages refuses the start with keys_unusable, not a TypeError", async () => {
		const lookalike = {
			algorithm: { name: "HMAC", hash: { name: "SHA-256" }, length: 256 },
		} as unknown as CryptoKey;
		const provider: KeyProvider = {
			current: async (purpose) =>
				purpose === "cookie-sig" ? { version: 1, key: lookalike } : genuine.current(purpose),
			byVersion: (purpose, version) => genuine.byVersion(purpose, version),
		};
		await expect(assertKeysAnswerForEveryPurpose(provider)).rejects.toMatchObject({
			code: "keys_unusable",
		});
	});

	it("the same-key fingerprint is the whole 32-byte probe MAC", async () => {
		const fingerprint = await sameKeyFingerprintOf((await genuine.current("token-mac")).key);
		expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("the stored-version probe", () => {
	let connection: TestConnection;
	let schema: string;
	beforeAll(async () => {
		({ connection, schema } = await openMigratedSchema("gaps_stored_probe"));
	});
	afterAll(async () => {
		await dropSchema(connection, schema);
		await connection.close();
	});

	it("asks the ring once per distinct stored version, not once per seal row", async () => {
		for (let account = 0; account < 25; account += 1) {
			const userId = await createUser(connection, schema);
			await connection.query(
				`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
				 VALUES ($1, 1, decode(repeat('00', 32), 'hex'), 1)`,
				[userId],
			);
		}
		let asked = 0;
		const keys: KeyProvider = {
			current: (purpose) => genuine.current(purpose),
			byVersion: (purpose, version) => {
				if (purpose === "state-mac") {
					asked += 1;
				}
				return genuine.byVersion(purpose, version);
			},
		};
		await assertStoredIntegrityKeysTakeMac({ driver: connection, keys, schema });
		expect(asked).toBe(1);
	});
});
