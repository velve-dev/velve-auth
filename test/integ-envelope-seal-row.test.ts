import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { encryptWithPurposeKey } from "../src/core/keys/envelope.js";
import { decryptBound } from "../src/core/keys/envelope-binding.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, requestTo } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { testKeyRing } from "./totp-fixtures.js";

/**
 * S-INTEG-1, last sentence: the unbound form is readable only in "migrating" AND only for an account
 * WITHOUT a seal row. The seal row is read in the statement that reads the envelope (E-3121).
 */

const PASSWORD = "a password long enough for the policy 7c1e";
const keys = testKeyRing(1).providerAt(1);

let connection: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("integ_seal_row");
	connection = migrated.connection;
	schema = migrated.schema;
}, 60_000);

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

describe("the seal-row half of S-INTEG-1", () => {
	it("refuses the unbound form under migrating for an account that has a seal row", async () => {
		const handler = toWebHandler(
			createVelveAuth(
				configFor({ database: connection, schema, keys, securityState: { sealing: "migrating" } }),
			),
		);
		const email = `sealed-${randomBytes(4).toString("hex")}@example.com`;
		expect(
			(await handler(requestTo("/sign-up", { body: { email, password: PASSWORD } }))).status,
		).toBe(200);
		const [user] = await connection.query<{ id: string }>(
			`SELECT id FROM ${schema}.user WHERE email = $1`,
			[email],
		);
		const userId = user?.id ?? "";
		const [row] = await connection.query<{ phc: Uint8Array; key_version: number }>(
			`SELECT phc, key_version FROM ${schema}.password_credential WHERE user_id = $1`,
			[userId],
		);
		const phc = await decryptBound(
			keys,
			{ column: "password_credential.phc", owner: userId, row: userId },
			{ keyVersion: row?.key_version ?? 1, ciphertext: Uint8Array.from(row?.phc ?? []) },
			"refused",
		);
		const unbound = await encryptWithPurposeKey(keys, "password-enc", phc);
		await connection.query(
			`UPDATE ${schema}.password_credential SET phc = $2, key_version = $3 WHERE user_id = $1`,
			[userId, unbound.ciphertext, unbound.keyVersion],
		);
		await connection.query(
			`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
			 VALUES ($1, 1, $2, 1) ON CONFLICT (user_id) DO NOTHING`,
			[userId, randomBytes(32)],
		);

		const answer = await handler(
			requestTo("/sign-in/password", { body: { email, password: PASSWORD } }),
		);

		expect(answer.status).toBe(401);
	});
});
