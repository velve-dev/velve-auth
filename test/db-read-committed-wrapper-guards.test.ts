import { describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { withReadCommittedTransactions } from "../src/core/db/read-committed.js";

//the wrapper states its isolation once and names only the refusal it was written for (E-3310)

function transactionDriver(statements: string[], failure?: unknown): Driver {
	const driver: Driver = {
		async query<T>(sql: string): Promise<T[]> {
			statements.push(sql);
			if (failure !== undefined && sql.startsWith("SET TRANSACTION")) {
				throw failure;
			}
			return [];
		},
		transaction: (work) => work(driver),
	};
	return driver;
}

describe("the READ COMMITTED wrapper", () => {
	it("states the isolation once when the wrapper is wrapped again", async () => {
		const statements: string[] = [];
		const wrapped = withReadCommittedTransactions(
			withReadCommittedTransactions(transactionDriver(statements)),
		);

		await wrapped.transaction(async (tx) => {
			await tx.query("SELECT 1", []);
		});

		expect(statements.filter((sql) => sql.startsWith("SET TRANSACTION"))).toHaveLength(1);
	});

	it("passes any other failure of the isolation statement through unchanged", async () => {
		const failure = Object.assign(new Error("connection lost"), { code: "08006" });

		await expect(
			withReadCommittedTransactions(transactionDriver([], failure)).transaction(async () => "ran"),
		).rejects.toBe(failure);
	});

	it("names a driver that reports 25001 under code, as node-postgres does", async () => {
		const failure = Object.assign(new Error("active"), { code: "25001" });

		await expect(
			withReadCommittedTransactions(transactionDriver([], failure)).transaction(async () => "ran"),
		).rejects.toMatchObject({ code: "transaction_isolation_refused" });
	});
});
