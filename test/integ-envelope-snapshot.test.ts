import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inOneTransaction } from "../src/core/auth/account-envelopes.js";
import type { Driver } from "../src/core/db/driver.js";
import { createTotpService, timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { encryptWithPurposeKey } from "../src/core/keys/envelope.js";
import { actorOfTestUser, createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { rebindAfterOneRead } from "./envelope-read-fixtures.js";
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

//every statement passes through, and the first read of the secret is followed by the conversion and a seal
function sealingRightAfterTheRead(userId: string, readsSeen: { count: number }): Driver {
	const reading = /FROM \S+\.totp_credential credential/;
	return {
		async query<T>(sql: string, parameters: unknown[]): Promise<T[]> {
			const rows = await connection.query<T>(sql, parameters);
			if (reading.test(sql) && readsSeen.count === 0) {
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
				await connection.query(
					`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
					 VALUES ($1, 1, $2, 1)`,
					[userId, new Uint8Array(32)],
				);
			}
			return rows;
		},
		transaction: (work) => connection.transaction(work),
	};
}

describe("the seal row is read in the statement that reads the envelope (S-INTEG-1)", () => {
	it("accepts the right code when the account is converted and sealed between read and use", async () => {
		const userId = await createUser(connection, schema);
		const actor = actorOfTestUser(userId);
		const enrolling = createTotpService({
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
		const readsSeen = { count: 0 };
		const migrating = createTotpService({
			driver: sealingRightAfterTheRead(userId, readsSeen),
			schema,
			keys,
			pending: pendingAuthenticationsOn(connection, schema),
			issuer: "Velve",
			clock: { now: () => new Date() },
			sealing: "migrating",
		});

		await expect(
			migrating.remove({ actor, code: totpCodeForStep(secret, timeStepAt(new Date())) }),
		).resolves.toBeUndefined();
		expect(readsSeen.count).toBe(1);
	});
});
