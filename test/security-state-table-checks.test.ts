import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";

// Migration 3 declares octet_length(digest) = 32 and key_version >= 1 on velve.security_state.
// These cases insert a digest of another length and key versions below one, so removing either
// check from the migration fails one of them, which was run before they were kept (E-3311).

let connection: TestConnection;
let schema: string;

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("seal_table_checks"));
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

async function outcomeOf(digestHex: string, keyVersion: number): Promise<string> {
	const userId = await createUser(connection, schema);
	return connection
		.query(
			`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
			 VALUES ($1, 1, decode($2, 'hex'), $3)`,
			[userId, digestHex, keyVersion],
		)
		.then(() => "stored")
		.catch((error: { sqlState?: string }) => error.sqlState ?? "no SQLSTATE");
}

describe("velve.security_state digest and key_version (migration 3)", () => {
	it("refuses a digest of 31 bytes and one of 33", async () => {
		expect(await outcomeOf("00".repeat(31), 1)).toBe("23514");
		expect(await outcomeOf("00".repeat(33), 1)).toBe("23514");
	});

	it("takes a digest of 32 bytes", async () => {
		expect(await outcomeOf("00".repeat(32), 1)).toBe("stored");
	});

	it("refuses a key version of zero and a negative one", async () => {
		expect(await outcomeOf("00".repeat(32), 0)).toBe("23514");
		expect(await outcomeOf("00".repeat(32), -1)).toBe("23514");
	});
});
