import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertStoredIntegrityKeysTakeMac } from "../src/core/auth/integrity-key-ring.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { rootKeyProvider } from "../src/core/keys/root-key-provider.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { generateRootKey } from "./keys-fixtures.js";

/**
 * E-3191 probes at start every stored state-mac version; migration 4 stores token-mac versions in
 * three more tables, so the probe reads those too (E-3148).
 */

let connection: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("token_mac_key_ring");
	connection = migrated.connection;
	schema = migrated.schema;
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

function ringWithAnAesTokenMacKeyAt(version: number, aes: CryptoKey): KeyProvider {
	const ring = rootKeyProvider({
		currentVersion: 2,
		keysByVersion: { 1: generateRootKey(), 2: generateRootKey() },
	});
	return {
		current: (purpose) => ring.current(purpose),
		byVersion: async (purpose, keyVersion) =>
			purpose === "token-mac" && keyVersion === version ? aes : ring.byVersion(purpose, keyVersion),
	};
}

const INSERTS: readonly (readonly [string, string])[] = [
	[
		"session",
		`INSERT INTO $S.session (user_id, token_sha256, idle_expires_at, absolute_expires_at,
		   token_mac, token_mac_key_version)
		 VALUES ($1, $2, now() + interval '1 day', now() + interval '2 days', $3, 1)`,
	],
	[
		"one_time_token",
		`INSERT INTO $S.one_time_token (token_sha256, purpose, user_id, expires_at,
		   token_mac, token_mac_key_version)
		 VALUES ($2, 'magic_link', $1, now() + interval '1 hour', $3, 1)`,
	],
	[
		"pending_authentication",
		`INSERT INTO $S.pending_authentication (token_sha256, user_id, factors_completed, expires_at,
		   token_mac, token_mac_key_version)
		 VALUES ($2, $1, '{password}', now() + interval '5 minutes', $3, 1)`,
	],
	[
		"webauthn_challenge",
		`INSERT INTO $S.webauthn_challenge (challenge_sha256, purpose, user_id, expires_at,
		   token_mac, token_mac_key_version)
		 VALUES ($2, 'register', $1, now() + interval '5 minutes', $3, 1)`,
	],
];

async function emptyTokenTables(): Promise<void> {
	for (const [table] of INSERTS) {
		await connection.query(`DELETE FROM ${schema}.${table}`, []);
	}
}

describe("the token-mac versions stored token rows still name (E-3148)", () => {
	it.each(INSERTS)(
		"refuses a ring whose token-mac version a %s row names cannot take an HMAC",
		async (_table, insert) => {
			const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
				"encrypt",
				"decrypt",
			]);
			const provider = ringWithAnAesTokenMacKeyAt(1, aes);
			await emptyTokenTables();

			await expect(
				assertStoredIntegrityKeysTakeMac({ driver: connection, keys: provider, schema }),
			).resolves.toBeUndefined();
			const userId = await createUser(connection, schema);
			await connection.query(insert.replace("$S", schema), [
				userId,
				randomBytes(32),
				randomBytes(32),
			]);

			await expect(
				assertStoredIntegrityKeysTakeMac({ driver: connection, keys: provider, schema }),
			).rejects.toMatchObject({ code: "keys_unusable" });
		},
	);
});
