import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTotpService, timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { encryptWithPurposeKey } from "../src/core/keys/envelope.js";
import { decryptBound } from "../src/core/keys/envelope-binding.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, requestTo } from "./auth-fixtures.js";
import { actorOfTestUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { resealDirectly, testSecurityState } from "./security-state-fixtures.js";
import { pendingAuthenticationsOn, secretBytesOfBase32, testKeyRing } from "./totp-fixtures.js";

//the old form opens only under migrating and only for an account without a seal row (E-3121)

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

	it("refuses an unbound TOTP secret under migrating for an account that has a seal row", async () => {
		const handler = toWebHandler(
			createVelveAuth(
				configFor({ database: connection, schema, keys, securityState: { sealing: "migrating" } }),
			),
		);
		const email = `totp-sealed-${randomBytes(4).toString("hex")}@example.com`;
		expect(
			(await handler(requestTo("/sign-up", { body: { email, password: PASSWORD } }))).status,
		).toBe(200);
		const [user] = await connection.query<{ id: string }>(
			`SELECT id FROM ${schema}.user WHERE email = $1`,
			[email],
		);
		const userId = user?.id ?? "";
		const actor = actorOfTestUser(userId);
		const totp = createTotpService({
			securityState: testSecurityState(connection, schema, keys),
			driver: connection,
			schema,
			keys,
			pending: pendingAuthenticationsOn(connection, schema),
			issuer: "Velve",
			clock: { now: () => new Date() },
		});
		const enrolment = await totp.enroll.start({ actor, accountName: email });
		const secret = secretBytesOfBase32(enrolment.secretBase32);
		await totp.enroll.finish({ actor, code: totpCodeForStep(secret, timeStepAt(new Date()) - 1) });
		const unbound = await encryptWithPurposeKey(keys, "totp-enc", secret);
		await connection.query(
			`UPDATE ${schema}.totp_credential SET secret_enc = $2, key_version = $3 WHERE user_id = $1`,
			[userId, unbound.ciphertext, unbound.keyVersion],
		);
		const verifyWithTheRightCode = async () => {
			const signedIn = await handler(
				requestTo("/sign-in/password", { body: { email, password: PASSWORD } }),
			);
			const pending = cookieOf(signedIn, DEFAULT_COOKIE_NAMES.pending);
			return (
				await handler(
					requestTo("/factor/totp/verify", {
						body: { code: totpCodeForStep(secret, timeStepAt(new Date())) },
						cookie: `${DEFAULT_COOKIE_NAMES.pending}=${pending}`,
					}),
				)
			).status;
		};
		//with the seal renewed over the old-form secret only the seal row's presence is left to refuse it (E-3165)
		await resealDirectly(connection, schema, keys, userId);

		expect(await verifyWithTheRightCode()).toBe(401);
		await connection.query(`DELETE FROM ${schema}.security_state WHERE user_id = $1`, [userId]);
		expect(await verifyWithTheRightCode()).toBe(200);
	});
});

function cookieOf(answer: Response, name: string): string | null {
	for (const line of answer.headers.getSetCookie()) {
		const [pair = ""] = line.split(";");
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === name && pair.slice(separator + 1) !== "") {
			return pair.slice(separator + 1);
		}
	}
	return null;
}
