import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rootKeyProvider } from "../src/core/keys/index.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { generateRootKey } from "./keys-fixtures.js";

// E-3088 and E-3093 have migrate() refuse a provider whose integrity key cannot take an HMAC, and
// E-3191 has it probe every state-mac version a seal row names. The other cases call the two probes
// directly; these reach them through migrate(), so removing either call from the instance fails
// one of them, which was run before they were kept (E-3311).

let connection: TestConnection;
let schema: string;

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("integrity_migrate_wiring"));
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

const genuine = rootKeyProvider({
	currentVersion: 2,
	keysByVersion: { 1: generateRootKey(), 2: generateRootKey() },
});

async function aesKey(): Promise<CryptoKey> {
	return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

function migrateWith(keys: KeyProvider) {
	return createVelveAuth(configFor({ database: connection, schema, keys })).migrate();
}

describe("migrate() and the integrity keys", () => {
	it("refuses a provider whose current state-mac key is not an HMAC key", async () => {
		const aes = await aesKey();
		const keys: KeyProvider = {
			current: async (purpose) =>
				purpose === "state-mac" ? { version: 2, key: aes } : genuine.current(purpose),
			byVersion: (purpose, version) => genuine.byVersion(purpose, version),
		};

		await expect(migrateWith(keys)).rejects.toMatchObject({ code: "keys_unusable" });
	});

	it("refuses a ring whose older state-mac version a stored seal names cannot take an HMAC", async () => {
		const aes = await aesKey();
		const userId = await createUser(connection, schema);
		await connection.query(
			`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
			 VALUES ($1, 1, decode(repeat('00', 32), 'hex'), 1)`,
			[userId],
		);
		const keys: KeyProvider = {
			current: (purpose) => genuine.current(purpose),
			byVersion: async (purpose, version) =>
				purpose === "state-mac" && version === 1 ? aes : genuine.byVersion(purpose, version),
		};

		await expect(migrateWith(keys)).rejects.toMatchObject({ code: "keys_unusable" });
	});
});
