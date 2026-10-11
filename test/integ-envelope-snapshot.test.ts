import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inOneTransaction } from "../src/core/auth/account-envelopes.js";
import type { Driver } from "../src/core/db/driver.js";
import { createTotpService, timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { encryptWithPurposeKey } from "../src/core/keys/envelope.js";
import { actorOfTestUser, createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { rebindAfterOneRead } from "./envelope-read-fixtures.js";
import { resealDirectly, testSecurityState } from "./security-state-fixtures.js";
import { pendingAuthenticationsOn, secretBytesOfBase32, testKeyRing } from "./totp-fixtures.js";

//a reader decides whether the old form opens from the snapshot it read the secret in (E-3121)

const keys = testKeyRing(1).providerAt(1);

let connection: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("integ_snapshot");
	connection = migrated.connection;
	schema = migrated.schema;
}, 60_000);

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

//every statement passes through, and the account lock is preceded once by the conversion and a seal
function sealingRightBeforeTheLock(userId: string, readsSeen: { count: number }): Driver {
	const locking = /FOR NO KEY UPDATE/;
	const intercepting = (inner: Driver): Driver => ({
		async query<T>(sql: string, parameters: unknown[]): Promise<T[]> {
			if (locking.test(sql) && readsSeen.count === 0) {
				readsSeen.count += 1;
				await inOneTransaction(connection, (transaction) =>
					rebindAfterOneRead({
						driver: transaction,
						schema,
						keys,
						actor: actorOfTestUser(userId),
						sealing: "migrating",
					}),
				);
				await resealDirectly(connection, schema, keys, userId);
			}
			return inner.query<T>(sql, parameters);
		},
		transaction: (work) => inner.transaction((tx) => work(intercepting(tx))),
	});
	return intercepting(connection);
}

//the sealing transaction reads seal row and secret under the lock in one statement (E-3165)
describe("the seal row is read in the statement that reads the envelope (S-INTEG-1)", () => {
	it("accepts the right code when the account is converted and sealed before the read under the lock", async () => {
		const userId = await createUser(connection, schema);
		const actor = actorOfTestUser(userId);
		const enrolling = createTotpService({
			securityState: testSecurityState(connection, schema, keys),
			driver: connection,
			schema,
			keys,
			pending: pendingAuthenticationsOn(connection, schema),
			issuer: "Velve",
			clock: { now: () => new Date() },
		});
		const enrolment = await enrolling.enroll.start({ actor, accountName: "order@example.com" });
		const secret = secretBytesOfBase32(enrolment.secretBase32);
		await enrolling.enroll.finish({
			actor,
			code: totpCodeForStep(secret, timeStepAt(new Date()) - 1),
		});
		const unbound = await encryptWithPurposeKey(keys, "totp-enc", secret);
		await connection.query(
			`UPDATE ${schema}.totp_credential SET secret_enc = $2, key_version = $3 WHERE user_id = $1`,
			[userId, unbound.ciphertext, unbound.keyVersion],
		);
		await connection.query(`DELETE FROM ${schema}.security_state WHERE user_id = $1`, [userId]);
		const readsSeen = { count: 0 };
		const migrating = createTotpService({
			securityState: testSecurityState(sealingRightBeforeTheLock(userId, readsSeen), schema, keys),
			driver: sealingRightBeforeTheLock(userId, readsSeen),
			schema,
			keys,
			pending: pendingAuthenticationsOn(connection, schema),
			issuer: "Velve",
			clock: { now: () => new Date() },
		});

		await expect(
			migrating.remove({ actor, code: totpCodeForStep(secret, timeStepAt(new Date())) }),
		).resolves.toBeUndefined();
		expect(readsSeen.count).toBe(1);
	});
});
