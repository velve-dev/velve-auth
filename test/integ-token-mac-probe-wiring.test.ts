import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { rootKeyProvider } from "../src/core/keys/root-key-provider.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { generateRootKey } from "./keys-fixtures.js";

// The documented start probe: migrate() refuses the start when a token-mac version some stored
// row names is answered with a key that cannot take an HMAC (E-3148, E-3191). The probe function
// is tested alone; this case holds that migrate() calls it.

let migrated: MigratedSchema;
let schema: string;

beforeAll(async () => {
	migrated = await openMigratedSchema("review_probe_wiring");
	schema = migrated.schema;
});

afterAll(async () => {
	await dropSchema(migrated.connection, schema);
	await migrated.connection.close();
});

describe("migrate() and the token-mac versions the token tables still name", () => {
	it("refuses the start when a stored session names a version whose key cannot take a MAC", async () => {
		const ring = rootKeyProvider({
			currentVersion: 2,
			keysByVersion: { 1: generateRootKey(), 2: generateRootKey() },
		});
		const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
			"encrypt",
			"decrypt",
		]);
		const keys: KeyProvider = {
			current: (purpose) => ring.current(purpose),
			byVersion: async (purpose, version) =>
				purpose === "token-mac" && version === 1 ? aes : ring.byVersion(purpose, version),
		};
		const userId = await createUser(migrated.connection, schema);
		await migrated.connection.query(
			`INSERT INTO ${schema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at,
			   token_mac, token_mac_key_version)
			 VALUES ($1, $2, now() + interval '1 day', now() + interval '2 days', $3, 1)`,
			[userId, randomBytes(32), randomBytes(32)],
		);
		const auth = createVelveAuth(configFor({ database: migrated.connection, schema, keys }));

		await expect(auth.migrate()).rejects.toMatchObject({ code: "keys_unusable" });
	});
});
