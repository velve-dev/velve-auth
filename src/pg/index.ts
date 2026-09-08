import type { Driver } from "../core/db/driver.js";

export interface NodePostgresQueryConfig {
	text: string;
	values: unknown[];
}

export interface NodePostgresResult {
	rows: unknown[];
}

export interface NodePostgresClient {
	query(config: NodePostgresQueryConfig): Promise<NodePostgresResult>;
	release(): void;
}

// A real `Pool` satisfies this because method syntax compares bivariantly; written as a
// property with an arrow type, node-postgres' overloaded `query` would no longer be assignable.
export interface NodePostgresPool {
	query(config: NodePostgresQueryConfig): Promise<NodePostgresResult>;
	connect(): Promise<NodePostgresClient>;
}

function driverOverClient(client: NodePostgresClient): Driver {
	return {
		async query<T>(sql: string, params: unknown[]): Promise<T[]> {
			const result = await client.query({ text: sql, values: params });
			return result.rows as T[];
		},
		transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T> {
			return fn(driverOverClient(client));
		},
	};
}

async function rollbackQuietly(client: NodePostgresClient): Promise<void> {
	try {
		await client.query({ text: "ROLLBACK", values: [] });
	} catch {
		// The rollback failure is never the cause the caller needs; the original error is rethrown.
	}
}

export function createNodePostgresDriver(pool: NodePostgresPool): Driver {
	return {
		async query<T>(sql: string, params: unknown[]): Promise<T[]> {
			const result = await pool.query({ text: sql, values: params });
			return result.rows as T[];
		},
		async transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T> {
			const client = await pool.connect();
			try {
				await client.query({ text: "BEGIN", values: [] });
				const result = await fn(driverOverClient(client));
				await client.query({ text: "COMMIT", values: [] });
				return result;
			} catch (error) {
				await rollbackQuietly(client);
				throw error;
			} finally {
				client.release();
			}
		},
	};
}
