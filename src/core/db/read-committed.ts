import type { Driver } from "./driver.js";

const READ_COMMITTED = "SET TRANSACTION ISOLATION LEVEL READ COMMITTED";

const statingReadCommitted = new WeakSet<Driver>();

//every transaction the library opens names its isolation instead of inheriting a default (E-3310)
export function withReadCommittedTransactions(driver: Driver): Driver {
	if (statingReadCommitted.has(driver)) {
		return driver;
	}
	const wrapped: Driver = {
		query<T>(sql: string, params: unknown[]): Promise<T[]> {
			return driver.query<T>(sql, params);
		},
		transaction<T>(work: (tx: Driver) => Promise<T>): Promise<T> {
			return driver.transaction(async (tx) => {
				await tx.query(READ_COMMITTED, []);
				return work(tx);
			});
		},
	};
	statingReadCommitted.add(wrapped);
	return wrapped;
}
