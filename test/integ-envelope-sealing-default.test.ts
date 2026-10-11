import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTotpService, timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { encryptWithPurposeKey } from "../src/core/keys/envelope.js";
import { createPasswordCredentialRepository } from "../src/core/password/credential.js";
import { createTestClock } from "../src/testing/index.js";
import { actorOfTestUser, createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { testSecurityState } from "./security-state-fixtures.js";
import { pendingAuthenticationsOn, secretBytesOfBase32, testKeyProvider } from "./totp-fixtures.js";

//a reader built without a sealing mode reads no old envelope (S-INTEG-1)

let connection: TestConnection;
let schema: string;
const keys = testKeyProvider();
const NOW = new Date("2026-05-03T18:45:00.000Z");
const PHC = `$argon2id$v=19$m=19456,t=2,p=1$${"c2FsdA".repeat(4)}$${"aGFzaA".repeat(7)}`;

beforeAll(async () => {
	const migrated = await openMigratedSchema("integ_sealing_default");
	connection = migrated.connection;
	schema = migrated.schema;
}, 60_000);

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

//the service reads its sealing mode from the security state it is given, "required" unless one is named (E-3165)
function totpServiceWith(sealing?: "migrating" | "required") {
	return createTotpService({
		securityState: testSecurityState(connection, schema, keys, { sealing: sealing ?? "required" }),
		driver: connection,
		schema,
		keys,
		pending: pendingAuthenticationsOn(connection, schema),
		issuer: "Velve",
		clock: createTestClock(NOW),
	});
}

async function accountWithAnUnboundConfirmedTotp(): Promise<{
	userId: string;
	code: string;
}> {
	const userId = await createUser(connection, schema);
	const actor = actorOfTestUser(userId);
	const service = totpServiceWith("migrating");
	const enrollment = await service.enroll.start({ actor, accountName: "a@example.com" });
	const secret = secretBytesOfBase32(enrollment.secretBase32);
	const code = totpCodeForStep(secret, timeStepAt(NOW));
	await service.enroll.finish({ actor, code });
	const unbound = await encryptWithPurposeKey(keys, "totp-enc", secret);
	await connection.query(
		`UPDATE ${schema}.totp_credential SET secret_enc = $2, key_version = $3 WHERE user_id = $1`,
		[userId, unbound.ciphertext, unbound.keyVersion],
	);
	//the enrolment sealed the account and an account from before the seal has no seal row (E-3165)
	await connection.query(`DELETE FROM ${schema}.security_state WHERE user_id = $1`, [userId]);
	return { userId, code: totpCodeForStep(secret, timeStepAt(NOW) + 1) };
}

describe("a reader built without a sealing mode refuses the old form (S-INTEG-1)", () => {
	it("reads a password envelope of an unsealed account as refused unless migrating is passed", async () => {
		const userId = await createUser(connection, schema);
		const unbound = await encryptWithPurposeKey(
			keys,
			"password-enc",
			new TextEncoder().encode(PHC),
		);
		await connection.query(
			`INSERT INTO ${schema}.password_credential (user_id, phc, key_version, scheme)
			 VALUES ($1, $2, $3, 'argon2id')`,
			[userId, unbound.ciphertext, unbound.keyVersion],
		);
		const repository = (sealing?: "migrating" | "required") =>
			createPasswordCredentialRepository({
				driver: connection,
				keys,
				schema,
				memoryCeilingKiB: 65_536,
				...(sealing === undefined ? {} : { sealing }),
			});

		expect((await repository().findByUserId(userId))?.unbound).toBe("refused");
		expect((await repository("required").findByUserId(userId))?.unbound).toBe("refused");
		expect((await repository("migrating").findByUserId(userId))?.unbound).toBe("readable");
	});

	it("refuses an unbound TOTP secret of an unsealed account unless migrating is passed", async () => {
		const refused = await accountWithAnUnboundConfirmedTotp();
		await expect(
			totpServiceWith().remove({ actor: actorOfTestUser(refused.userId), code: refused.code }),
		).rejects.toMatchObject({ reason: "broken_state_on_change" });
		const [kept] = await connection.query(
			`SELECT 1 FROM ${schema}.totp_credential WHERE user_id = $1`,
			[refused.userId],
		);
		expect(kept).toBeDefined();

		const readable = await accountWithAnUnboundConfirmedTotp();
		await totpServiceWith("migrating").remove({
			actor: actorOfTestUser(readable.userId),
			code: readable.code,
		});
	});
});
