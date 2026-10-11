import type { Driver } from "./driver.js";

const READ_COMMITTED = "SET TRANSACTION ISOLATION LEVEL READ COMMITTED";

const ACTIVE_SQL_TRANSACTION = "25001";

const statingReadCommitted = new WeakSet<Driver>();

/** a driver ran a statement in its transaction before handing it over, so the isolation could not be set */
class TransactionIsolationRefusedError extends Error {
	readonly code = "transaction_isolation_refused";

	constructor(cause: unknown) {
		super(
			"the driver's transaction() ran a statement before the library's work, so SET TRANSACTION ISOLATION LEVEL READ COMMITTED was refused; transaction(fn) must run no statement before fn",
			{ cause },
		);
		this.name = "TransactionIsolationRefusedError";
	}
}

function isActiveTransactionRefusal(error: unknown): boolean {
	const fields = error as { readonly sqlState?: unknown; readonly code?: unknown } | null;
	return fields?.sqlState === ACTIVE_SQL_TRANSACTION || fields?.code === ACTIVE_SQL_TRANSACTION;
}

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
				await tx.query(READ_COMMITTED, []).catch((error: unknown) => {
					throw isActiveTransactionRefusal(error)
						? new TransactionIsolationRefusedError(error)
						: error;
				});
				return work(tx);
			});
		},
	};
	statingReadCommitted.add(wrapped);
	return wrapped;
}
