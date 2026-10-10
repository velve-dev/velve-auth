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

//a copied old envelope opens under migrating until the account is sealed (E-3122)

const keys = testKeyRing(1).providerAt(1);
const ATTACKER_PASSWORD = "the attacker's own password, long enough 91";
const VICTIM_PASSWORD = "the victim's password, also long enough 3e";

let connection: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("integ_migrating_limit");
	connection = migrated.connection;
	schema = migrated.schema;
}, 60_000);

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

describe("an old-form password copied across accounts (S-INTEG-1, E-3122)", () => {
	it("opens under migrating for an unsealed account, and is refused once sealed and under required", async () => {
		const handlerUnder = (sealing: "migrating" | "required") =>
			toWebHandler(
				createVelveAuth(
					configFor({ database: connection, schema, keys, securityState: { sealing } }),
				),
			);
		const migrating = handlerUnder("migrating");
		const required = handlerUnder("required");
		const ids: Record<string, string> = {};
		for (const [who, password] of [
			["attacker", ATTACKER_PASSWORD],
			["victim", VICTIM_PASSWORD],
		] as const) {
			const email = `${who}-${randomBytes(4).toString("hex")}@example.com`;
			expect((await migrating(requestTo("/sign-up", { body: { email, password } }))).status).toBe(
				200,
			);
			const [row] = await connection.query<{ id: string }>(
				`SELECT id FROM ${schema}.user WHERE email = $1`,
				[email],
			);
			ids[who] = row?.id ?? "";
			ids[`${who}Email`] = email;
		}
		const attackerId = ids.attacker ?? "";
		const [row] = await connection.query<{ phc: Uint8Array; key_version: number }>(
			`SELECT phc, key_version FROM ${schema}.password_credential WHERE user_id = $1`,
			[attackerId],
		);
		const attackerPhc = await decryptBound(
			keys,
			{ column: "password_credential.phc", owner: attackerId, row: attackerId },
			{ keyVersion: row?.key_version ?? 1, ciphertext: Uint8Array.from(row?.phc ?? []) },
			"refused",
		);
		//the old form the writer's own account carried before the upgrade
		const kept = await encryptWithPurposeKey(keys, "password-enc", attackerPhc);
		await connection.query(
			`UPDATE ${schema}.password_credential SET phc = $2, key_version = $3 WHERE user_id = $1`,
			[ids.victim, kept.ciphertext, kept.keyVersion],
		);
		//an account from before the seal has no seal row, as a sign-up now writes one (E-3165)
		await connection.query(`DELETE FROM ${schema}.security_state WHERE user_id = $1`, [ids.victim]);
		const asTheVictimWithTheWritersPassword = async (handler: typeof migrating) =>
			(
				await handler(
					requestTo("/sign-in/password", {
						body: { email: ids.victimEmail, password: ATTACKER_PASSWORD },
					}),
				)
			).status;

		expect(await asTheVictimWithTheWritersPassword(migrating)).toBe(200);
		expect(await asTheVictimWithTheWritersPassword(required)).toBe(401);
		await connection.query(
			`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
			 VALUES ($1, 1, $2, 1)`,
			[ids.victim, randomBytes(32)],
		);
		expect(await asTheVictimWithTheWritersPassword(migrating)).toBe(401);
	});
});
