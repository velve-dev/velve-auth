import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockAccountRowStatement } from "../src/core/db/lock.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

// Section 3.18 *Sealing* and point 5: a re-encryption opens exactly the ciphertext the one
// verified read returned and writes by compare-and-set on it, and a write that hits no row is a
// broken state (E-3300). A writer who puts an older ciphertext of the same row in place between the
// read and the rewrite makes the compare-and-set miss. These cases hold that, the control that the
// same write hits the row when nobody writes, and as a second control what a second read would
// have done: returned the writer's older ciphertext for the re-encryption to carry forward. The
// re-encryption code is the bound-envelope branch's and the administration branch's.

let maintainer: TestConnection;
let writer: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("reencrypt_compare");
	maintainer = migrated.connection;
	schema = migrated.schema;
	writer = await openTestConnection();
});

afterAll(async () => {
	await dropSchema(maintainer, schema);
	await maintainer.close();
	await writer.close();
});

async function rewriteAfterTheVerifiedRead(writerSwaps: boolean) {
	const userId = await createUser(maintainer, schema);
	await maintainer.query(
		`INSERT INTO ${schema}.password_credential (user_id, phc, key_version, scheme)
		 VALUES ($1, decode('aa', 'hex'), 1, 'argon2id')`,
		[userId],
	);
	await maintainer.query("BEGIN ISOLATION LEVEL READ COMMITTED", []);
	try {
		await maintainer.query(lockAccountRowStatement(schema), [userId]);
		const [verified] = await maintainer.query<{ phc: Buffer }>(
			`SELECT phc FROM ${schema}.password_credential WHERE user_id = $1`,
			[userId],
		);
		if (writerSwaps) {
			await writer.query(
				`UPDATE ${schema}.password_credential SET phc = decode('0a', 'hex') WHERE user_id = $1`,
				[userId],
			);
		}
		const [secondRead] = await maintainer.query<{ phc: Buffer }>(
			`SELECT phc FROM ${schema}.password_credential WHERE user_id = $1`,
			[userId],
		);
		const written = await maintainer.query(
			`UPDATE ${schema}.password_credential SET phc = decode('bb', 'hex'), key_version = 2
			 WHERE user_id = $1 AND phc = $2 RETURNING user_id`,
			[userId, verified?.phc],
		);
		return {
			rowsWritten: written.length,
			secondRead: Buffer.from(secondRead?.phc ?? []).toString("hex"),
		};
	} finally {
		await maintainer.query("ROLLBACK", []).catch(() => undefined);
	}
}

describe("premise: a re-encryption on a sealed account (section 3.18, Sealing and point 5)", () => {
	it("writes nothing when a writer swapped the ciphertext after the verified read", async () => {
		expect((await rewriteAfterTheVerifiedRead(true)).rowsWritten).toBe(0);
	});

	it("control: the same compare-and-set writes the row when nobody writes", async () => {
		expect((await rewriteAfterTheVerifiedRead(false)).rowsWritten).toBe(1);
	});

	it("control: a second read would hand the re-encryption the writer's older ciphertext", async () => {
		expect((await rewriteAfterTheVerifiedRead(true)).secondRead).toBe("0a");
	});
});
