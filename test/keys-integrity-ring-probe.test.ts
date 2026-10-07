import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rootKeyProvider } from "../src/core/keys/index.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { generateRootKey } from "./keys-fixtures.js";

//the stored-version probe walks every key_version a seal row names (E-3330)

let connection: TestConnection;
let schema: string;

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("ring_probe"));
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

const genuine = rootKeyProvider({
	currentVersion: 3,
	keysByVersion: { 1: generateRootKey(), 2: generateRootKey(), 3: generateRootKey() },
});

describe("migrate() and two stored state-mac versions", () => {
	it("refuses the start when only the later stored version cannot take an HMAC", async () => {
		const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
			"encrypt",
			"decrypt",
		]);
		for (const keyVersion of [1, 2]) {
			const userId = await createUser(connection, schema);
			await connection.query(
				`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
				 VALUES ($1, 1, decode(repeat('00', 32), 'hex'), $2)`,
				[userId, keyVersion],
			);
		}
		const keys: KeyProvider = {
			current: (purpose) => genuine.current(purpose),
			byVersion: async (purpose, version) =>
				purpose === "state-mac" && version === 2 ? aes : genuine.byVersion(purpose, version),
		};

		await expect(
			createVelveAuth(configFor({ database: connection, schema, keys })).migrate(),
		).rejects.toMatchObject({ code: "keys_unusable" });
	});
});
