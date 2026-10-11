import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rootKeyProvider } from "../src/core/keys/index.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { createUser, dropSchema, openMigratedSchema, uniqueSchemaName } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { generateRootKey } from "./keys-fixtures.js";

//a provider the start refuses is refused before a migration writes anything (E-3374)

let connection: TestConnection;
const freshSchema = uniqueSchemaName("keys_first");
let migratedSchema: string;

beforeAll(async () => {
	connection = await openTestConnection();
	const migrated = await openMigratedSchema("keys_first_sealed");
	migratedSchema = migrated.schema;
	await migrated.connection.close();
});

afterAll(async () => {
	await dropSchema(connection, freshSchema);
	await dropSchema(connection, migratedSchema);
	await connection.close();
});

describe("migrate() with a provider that cannot answer token-mac", () => {
	it("applies no migration before it refuses the start", async () => {
		const genuine = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });
		const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
			"encrypt",
			"decrypt",
		]);
		const keys: KeyProvider = {
			current: async (purpose) =>
				purpose === "token-mac" ? { version: 1, key: aes } : genuine.current(purpose),
			byVersion: (purpose, version) => genuine.byVersion(purpose, version),
		};

		await expect(
			createVelveAuth(configFor({ database: connection, schema: freshSchema, keys })).migrate(),
		).rejects.toMatchObject({ code: "keys_unusable" });

		const [ledger] = await connection.query<{ relation: string | null }>(
			"SELECT to_regclass($1)::text AS relation",
			[`${freshSchema}.schema_migration`],
		);
		expect(ledger?.relation ?? null).toBeNull();
	});
});

describe("migrate() with a provider whose current key for cookie-sig rejects", () => {
	it("refuses the start as keys_unusable and not with the provider's own error, with a seal row stored", async () => {
		const genuine = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });
		const userId = await createUser(connection, migratedSchema);
		await connection.query(
			`INSERT INTO ${migratedSchema}.security_state (user_id, version, digest, key_version)
			 VALUES ($1, 1, decode(repeat('00', 32), 'hex'), 1)`,
			[userId],
		);
		const keys: KeyProvider = {
			current: (purpose) =>
				purpose === "cookie-sig"
					? Promise.reject(new Error("the key service is down"))
					: genuine.current(purpose),
			byVersion: (purpose, version) => genuine.byVersion(purpose, version),
		};

		await expect(
			createVelveAuth(configFor({ database: connection, schema: migratedSchema, keys })).migrate(),
		).rejects.toMatchObject({ code: "keys_unusable" });
	});
});
