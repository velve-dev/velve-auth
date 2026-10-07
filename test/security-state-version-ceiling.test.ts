import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";

// Section 3.18 *Resealing*: a writer who stores the largest version the column accepts leaves the
// administrator reseal no higher version to write, and the call refuses with
// security_state_version_exhausted. This case holds the premise that the table itself refuses the
// next version; the reseal that names the refusal is the administration branch's (E-3213).

let connection: TestConnection;
let schema: string;

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("version_ceiling"));
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

describe("a seal row at the largest storable version (S-INTEG-7)", () => {
	it("refuses any version above it, so a reseal has nothing left to write", async () => {
		const userId = await createUser(connection, schema);
		await connection.query(
			`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
			 VALUES ($1, 9007199254740991, decode(repeat('00', 32), 'hex'), 1)`,
			[userId],
		);
		const raised = await connection
			.query(
				`UPDATE ${schema}.security_state SET version = version + 1, session_epoch = version + 1
				 WHERE user_id = $1`,
				[userId],
			)
			.then(() => "raised")
			.catch(() => "refused by the table");

		expect(raised).toBe("refused by the table");
	});
});
