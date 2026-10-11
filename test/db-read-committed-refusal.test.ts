import { describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { withReadCommittedTransactions } from "../src/core/db/read-committed.js";

//only an active-transaction refusal is renamed, in either field drivers carry it in (E-3331)

function driverWhoseIsolationStatementFails(failure: unknown): Driver {
	const tx: Driver = {
		query: () => Promise.reject(failure),
		transaction: () => Promise.reject(new Error("not used")),
	};
	return {
		query: () => Promise.resolve([]),
		transaction: (work) => work(tx),
	};
}

describe("the refusal of the isolation statement", () => {
	it.each([
		["node-postgres and postgres.js carry it as code", { code: "25001" }],
		["the test connection carries it as sqlState", { sqlState: "25001" }],
	])("is named when %s", async (_shape, failure) => {
		const outcome = await withReadCommittedTransactions(driverWhoseIsolationStatementFails(failure))
			.transaction(async () => "ran")
			.catch((error: { name?: string }) => error.name);

		expect(outcome).toBe("TransactionIsolationRefusedError");
	});

	it.each([
		["a serialization failure", { code: "40001" }],
		["a connection loss", new Error("connection terminated")],
		["a failure with neither field", {}],
	])("passes %s through unchanged", async (_what, failure) => {
		const outcome = await withReadCommittedTransactions(driverWhoseIsolationStatementFails(failure))
			.transaction(async () => "ran")
			.catch((error: unknown) => error);

		expect(outcome).toBe(failure);
	});
});

describe("wrapping a wrapped driver", () => {
	it("gives a transaction the isolation statement once, as the documentation promises", async () => {
		const statements: string[] = [];
		const base: Driver = {
			query: async (sql) => {
				statements.push(sql);
				return [];
			},
			transaction: (work) => work(base),
		};
		const once = withReadCommittedTransactions(base);

		await withReadCommittedTransactions(once).transaction(async () => undefined);

		expect(withReadCommittedTransactions(once)).toBe(once);
		expect(statements.filter((sql) => sql.startsWith("SET TRANSACTION"))).toHaveLength(1);
	});
});
