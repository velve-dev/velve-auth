import type { Driver } from "../src/core/db/driver.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

/**
 * One test connection serialises its statements and nests a second transaction into the first, so
 * concurrent sign-ins through one of them are not concurrent sign-ins at all. This hands each
 * statement and each transaction a connection of its own, as a real driver's pool does.
 */
interface ConnectionPool extends Driver {
	close(): Promise<void>;
}

/**
 * A pool waits for a free connection without limit by default, as `pg` does; `acquireTimeoutMs`
 * makes a wait that would never end fail instead, as `connectionTimeoutMillis` does.
 */
export async function openConnectionPool(
	size: number,
	options: {
		readonly acquireTimeoutMs?: number;
		/** the isolation a connection's own transactions default to, as a server or role setting would */
		readonly defaultIsolation?: "repeatable read";
	} = {},
): Promise<ConnectionPool> {
	const connections: TestConnection[] = [];
	for (let index = 0; index < size; index += 1) {
		const connection = await openTestConnection();
		if (options.defaultIsolation !== undefined) {
			await connection.query(
				`SET default_transaction_isolation = '${options.defaultIsolation}'`,
				[],
			);
		}
		connections.push(connection);
	}
	const idle = [...connections];
	const waiting: ((connection: TestConnection) => void)[] = [];

	function acquire(): Promise<TestConnection> {
		const free = idle.pop();
		if (free !== undefined) {
			return Promise.resolve(free);
		}
		return new Promise((resolve, reject) => {
			const handOver = (connection: TestConnection): void => {
				clearTimeout(timer);
				resolve(connection);
			};
			const timer =
				options.acquireTimeoutMs === undefined
					? undefined
					: setTimeout(() => {
							waiting.splice(waiting.indexOf(handOver), 1);
							reject(new Error("no pooled connection became free in time"));
						}, options.acquireTimeoutMs);
			waiting.push(handOver);
		});
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
