import { describe, expect, it } from "vitest";
import {
	createNodePostgresDriver,
	type NodePostgresClient,
	type NodePostgresPool,
	type NodePostgresQueryConfig,
	type NodePostgresResult,
} from "../src/pg/index.js";

interface RecordedPool extends NodePostgresPool {
	readonly statements: string[];
	readonly releases: number[];
}

function recordingPool(behaviour: { rows?: unknown[]; failOn?: string }): RecordedPool {
	const statements: string[] = [];
	const releases: number[] = [];

	async function run(config: NodePostgresQueryConfig): Promise<NodePostgresResult> {
		statements.push(config.text);
		if (config.text === behaviour.failOn) {
			throw new Error(`statement rejected: ${config.text}`);
		}
		return { rows: behaviour.rows ?? [] };
	}

	const client: NodePostgresClient = {
		query: run,
		release() {
			releases.push(statements.length);
		},
	};

	return {
		statements,
		releases,
		query: run,
		connect: async () => client,
	};
}

describe("node-postgres driver", () => {
	it("passes statement and parameters through unchanged", async () => {
		const pool = recordingPool({ rows: [{ id: 1 }] });
		const driver = createNodePostgresDriver(pool);

		const rows = await driver.query<{ id: number }>("SELECT id FROM t WHERE id = $1", [1]);

		expect(rows).toEqual([{ id: 1 }]);
		expect(pool.statements).toEqual(["SELECT id FROM t WHERE id = $1"]);
	});

	it("wraps a transaction in BEGIN and COMMIT and releases the client", async () => {
		const pool = recordingPool({});
		const driver = createNodePostgresDriver(pool);

		await driver.transaction(async (tx) => {
			await tx.query("INSERT INTO t VALUES ($1)", ["a"]);
		});

		expect(pool.statements).toEqual(["BEGIN", "INSERT INTO t VALUES ($1)", "COMMIT"]);
		expect(pool.releases).toEqual([3]);
	});

	it("rolls back and rethrows when the body fails", async () => {
		const pool = recordingPool({});
		const driver = createNodePostgresDriver(pool);

		await expect(
			driver.transaction(async () => {
				throw new Error("body failed");
			}),
		).rejects.toThrow("body failed");

		expect(pool.statements).toEqual(["BEGIN", "ROLLBACK"]);
		expect(pool.releases).toEqual([2]);
	});

	it("reports the original error when the rollback itself fails", async () => {
		const pool = recordingPool({ failOn: "ROLLBACK" });
		const driver = createNodePostgresDriver(pool);

		await expect(
			driver.transaction(async () => {
				throw new Error("body failed");
			}),
		).rejects.toThrow("body failed");
	});

	it("joins a nested transaction to the open one instead of opening a second", async () => {
		const pool = recordingPool({});
		const driver = createNodePostgresDriver(pool);

		await driver.transaction(async (tx) => {
			await tx.transaction(async (inner) => {
				await inner.query("SELECT 1", []);
			});
		});

		expect(pool.statements).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
	});
});
