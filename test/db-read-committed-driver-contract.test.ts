import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { withReadCommittedTransactions } from "../src/core/db/read-committed.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

//a driver that runs a statement before handing over its transaction is named, never silently tolerated (E-3331)

let connection: TestConnection;

beforeAll(async () => {
	connection = await openTestConnection();
	await connection.query("SET default_transaction_isolation = 'repeatable read'", []);
});

afterAll(async () => {
	await connection.close();
});

function driverThatSetsATenantFirst(): Driver {
	return {
		query: (sql, params) => connection.query(sql, params),
		async transaction<T>(work: (tx: Driver) => Promise<T>): Promise<T> {
			await connection.query("BEGIN", []);
			try {
				await connection.query("SELECT set_config('app.tenant', 'a', true)", []);
				const result = await work(connection);
				await connection.query("COMMIT", []);
				return result;
			} catch (error) {
				await connection.query("ROLLBACK", []).catch(() => undefined);
				throw error;
			}
		},
	};
}

describe("a driver that runs a statement before handing over its transaction", () => {
	it("fails the library's transaction with a named error instead of the bare 25001", async () => {
		const outcome = await withReadCommittedTransactions(driverThatSetsATenantFirst())
			.transaction(async () => "ran")
			.catch((error: { name?: string; code?: string; cause?: { sqlState?: string } }) => ({
				name: error.name,
				code: error.code,
				causeSqlState: error.cause?.sqlState,
			}));

		expect(outcome).toStrictEqual({
			name: "TransactionIsolationRefusedError",
			code: "transaction_isolation_refused",
			causeSqlState: "25001",
		});
	});
});
