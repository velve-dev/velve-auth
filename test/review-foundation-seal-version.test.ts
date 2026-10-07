import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";

// Reviewer test for migration 3 against section 3.15 A.8 and G: the seal's version reaches the
// application as `number` (resealSecurityState returns { version: number }, SecurityStateSealedEvent
// carries version: number, minimumVersion returns number | null), but the column is an unbounded
// bigint. A writer can store a version no JavaScript number represents, and "the new version lies
// above the stored one" (S-INTEG-7) then has no exact answer. Expected: the table refuses it.

let connection: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("review_seal_version");
	connection = migrated.connection;
	schema = migrated.schema;
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

describe("velve.security_state.version and the number the interface carries (migration 3)", () => {
	it("refuses a version above Number.MAX_SAFE_INTEGER", async () => {
		const userId = await createUser(connection, schema);

		const stored = await connection
			.query(
				`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
VALUES ($1, $2::bigint, decode(repeat('00', 32), 'hex'), 1)`,
				[userId, "9223372036854775807"],
			)
			.then(() => "stored")
			.catch(() => "refused");

		expect(stored).toBe("refused");
	});
});
