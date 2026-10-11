import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { coreMigrations, runMigrations } from "../src/schema/index.js";
import { dropSchema, uniqueSchemaName } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

//every transaction the public migration runner opens states read committed itself (E-3328)

let observer: TestConnection;

beforeAll(async () => {
	observer = await openTestConnection();
});

afterAll(async () => {
	await observer.close();
});

function recordingFirstStatements(driver: Driver, firsts: string[]): Driver {
	return {
		query: (sql, params) => driver.query(sql, params),
		transaction: (work) =>
			driver.transaction((tx) => {
				let first = true;
				return work({
					query: (sql, params) => {
						if (first) {
							firsts.push(sql.trim().split(/\s+/).slice(0, 5).join(" "));
							first = false;
						}
						return tx.query(sql, params);
					},
					transaction: (inner) => tx.transaction(inner),
				});
			}),
	};
}

describe("transactions runMigrations opens", () => {
	it("start with SET TRANSACTION ISOLATION LEVEL READ COMMITTED", async () => {
		const schema = uniqueSchemaName("runner_rc_first");
		const connection = await openTestConnection();
		const firsts: string[] = [];
		try {
			await runMigrations({
				driver: recordingFirstStatements(connection, firsts),
				schema,
				migrations: coreMigrations("email"),
			});
		} finally {
			await connection.close();
			await dropSchema(observer, schema);
		}
		expect(firsts.length).toBeGreaterThan(0);
		expect(firsts.filter((sql) => !sql.startsWith("SET TRANSACTION ISOLATION LEVEL READ"))).toEqual(
			[],
		);
	});

	it("let concurrent runners on repeatable-read connections all succeed", async () => {
		const schema = uniqueSchemaName("runner_rr_concurrent");
		const connections = await Promise.all(Array.from({ length: 4 }, () => openTestConnection()));
		try {
			for (const connection of connections) {
				await connection.query("SET default_transaction_isolation = 'repeatable read'", []);
			}
			const outcomes = await Promise.allSettled(
				connections.map((driver) =>
					runMigrations({ driver, schema, migrations: coreMigrations("email") }),
				),
			);
			expect(
				outcomes
					.filter((outcome) => outcome.status === "rejected")
					.map((outcome) => String((outcome as PromiseRejectedResult).reason)),
			).toEqual([]);
		} finally {
			await Promise.all(connections.map((connection) => connection.close()));
			await dropSchema(observer, schema);
		}
	});
});
