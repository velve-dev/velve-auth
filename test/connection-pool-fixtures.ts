import type { Driver } from "../src/core/db/driver.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

/**
 * One test connection serialises its statements and nests a second transaction into the first, so
 * concurrent sign-ins through one of them are not concurrent sign-ins at all. This hands each
 * statement and each transaction a connection of its own, as a real driver's pool does.
 */
export interface ConnectionPool extends Driver {
	close(): Promise<void>;
}

export async function openConnectionPool(size: number): Promise<ConnectionPool> {
	const connections: TestConnection[] = [];
	for (let index = 0; index < size; index += 1) {
		connections.push(await openTestConnection());
	}
	const idle = [...connections];
	const waiting: ((connection: TestConnection) => void)[] = [];

	function acquire(): Promise<TestConnection> {
		const free = idle.pop();
		return free === undefined
			? new Promise((resolve) => waiting.push(resolve))
			: Promise.resolve(free);
	}

	function release(connection: TestConnection): void {
		const next = waiting.shift();
		if (next === undefined) {
			idle.push(connection);
		} else {
			next(connection);
		}
	}

	async function holding<T>(use: (connection: TestConnection) => Promise<T>): Promise<T> {
		const connection = await acquire();
		try {
			return await use(connection);
		} finally {
			release(connection);
		}
	}

	return {
		query: (sql, params) => holding((connection) => connection.query(sql, params)),
		transaction: (work) => holding((connection) => connection.transaction(work)),
		close: async () => {
			for (const connection of connections) {
				await connection.close();
			}
		},
	};
}
