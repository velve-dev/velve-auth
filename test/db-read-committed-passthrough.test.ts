import { describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { withReadCommittedTransactions } from "../src/core/db/read-committed.js";

//the wrapper passes a plain statement through and gives a joined transaction no second isolation statement (E-3330)

function recordingDriver(statements: string[], transactions: { opened: number }): Driver {
	const driver: Driver = {
		async query<T>(sql: string): Promise<T[]> {
			statements.push(sql);
			return [];
		},
		transaction<T>(work: (tx: Driver) => Promise<T>): Promise<T> {
			transactions.opened += 1;
			return work(driver);
		},
	};
	return driver;
}

describe("withReadCommittedTransactions", () => {
	it("passes a statement outside a transaction through without opening one", async () => {
		const statements: string[] = [];
		const transactions = { opened: 0 };

		await withReadCommittedTransactions(recordingDriver(statements, transactions)).query(
			"SELECT 1",
			[],
		);

		expect({ statements, opened: transactions.opened }).toStrictEqual({
			statements: ["SELECT 1"],
			opened: 0,
		});
	});

	it("gives the isolation statement once to a transaction joined from inside another", async () => {
		const statements: string[] = [];
		const transactions = { opened: 0 };

		await withReadCommittedTransactions(recordingDriver(statements, transactions)).transaction(
			async (tx) => {
				await tx.transaction(async (inner) => {
					await inner.query("SELECT 2", []);
				});
			},
		);

		expect(
			statements.filter((sql) => sql.startsWith("SET TRANSACTION ISOLATION LEVEL")),
		).toHaveLength(1);
	});
});
