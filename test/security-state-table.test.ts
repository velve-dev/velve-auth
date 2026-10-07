import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";

// The seal's version reaches the application as a number (section 3.15 B and G), so the column
// must not hold one that a JavaScript number cannot represent exactly (E-3092).

let connection: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("seal_version");
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

	it("keeps Number.MAX_SAFE_INTEGER itself, the last version a number holds", async () => {
		const userId = await createUser(connection, schema);

		const [row] = await connection.query<{ version: string }>(
			`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
VALUES ($1, $2::bigint, decode(repeat('00', 32), 'hex'), 1) RETURNING version::text AS version`,
			[userId, String(Number.MAX_SAFE_INTEGER)],
		);

		expect(row?.version).toBe(String(Number.MAX_SAFE_INTEGER));
	});

	it("refuses a version of zero", async () => {
		const userId = await createUser(connection, schema);

		const stored = await connection
			.query(
				`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
VALUES ($1, 0, decode(repeat('00', 32), 'hex'), 1)`,
				[userId],
			)
			.then(() => "stored")
			.catch(() => "refused");

		expect(stored).toBe("refused");
	});
});
