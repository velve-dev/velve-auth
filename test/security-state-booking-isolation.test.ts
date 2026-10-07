import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPendingToken } from "../src/core/factor/pending/token.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { beginPendingState, pendingAuthenticationsOn } from "./totp-fixtures.js";

// Section 3.18 point 3 books a second-factor attempt by compare-and-set and, when the booking hits
// no row, re-reads once. The booking and the re-read are their own READ COMMITTED statements,
// where a lost booking misses and the re-read sees the winner. The control holds why the factor
// check no longer reads inside a REPEATABLE READ transaction: there the lost booking does not
// miss, PostgreSQL refuses it with 40001, and the specification's case table is never reached
// (E-3280).

let owner: TestConnection;
let other: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("booking_isolation");
	owner = migrated.connection;
	schema = migrated.schema;
	other = await openTestConnection();
});

afterAll(async () => {
	await dropSchema(owner, schema);
	await owner.close();
	await other.close();
});

async function losingBookingAt(isolation: string): Promise<string> {
	const userId = await createUser(owner, schema);
	const { token } = await beginPendingState(pendingAuthenticationsOn(owner, schema), userId);
	const tokenHash = hashPendingToken(token);
	await other.query(`BEGIN ISOLATION LEVEL ${isolation}`, []);
	try {
		const [pinned] = await other.query<{ attempts: number }>(
			`SELECT attempts FROM ${schema}.pending_authentication WHERE token_sha256 = $1`,
			[tokenHash],
		);
		await owner.query(
			`UPDATE ${schema}.pending_authentication SET attempts = attempts + 1 WHERE token_sha256 = $1`,
			[tokenHash],
		);
		return await other
			.query(
				`UPDATE ${schema}.pending_authentication SET attempts = $2 + 1
				 WHERE token_sha256 = $1 AND attempts = $2 RETURNING attempts`,
				[tokenHash, pinned?.attempts ?? -1],
			)
			.then(
				(rows) => (rows.length === 0 ? "missed" : "booked"),
				(error: { sqlState?: string; code?: string }) => error.sqlState ?? error.code ?? "error",
			);
	} finally {
		await other.query("ROLLBACK", []).catch(() => undefined);
	}
}

describe("a booking that loses to a concurrent booking (section 3.18 point 3)", () => {
	it("at READ COMMITTED misses, so the re-read of the case table is reached", async () => {
		expect(await losingBookingAt("READ COMMITTED")).toBe("missed");
	});

	it("control: inside a REPEATABLE READ transaction is refused with 40001 instead", async () => {
		expect(await losingBookingAt("REPEATABLE READ")).toBe("40001");
	});
});
