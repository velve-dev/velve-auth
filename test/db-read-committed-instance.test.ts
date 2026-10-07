import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, requestTo } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";

//the assembled instance must open its own transactions at read committed (E-3310)

let connection: TestConnection;
let schema: string;

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("instance_read_committed"));
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

function firstStatementRecorder(firsts: string[]): Driver {
	return {
		query: (sql, params) => connection.query(sql, params),
		transaction: (work) =>
			connection.transaction((tx) => {
				let first = true;
				return work({
					query: (sql, params) => {
						if (first) {
							firsts.push(sql.trim().split(/\s+/).slice(0, 6).join(" "));
							first = false;
						}
						return tx.query(sql, params);
					},
					transaction: (inner) => tx.transaction(inner),
				});
			}),
	};
}

describe("the instance and the isolation of the transactions it opens", () => {
	it("states READ COMMITTED first in every transaction a sign-up opens", async () => {
		const firsts: string[] = [];
		const auth = createVelveAuth(configFor({ database: firstStatementRecorder(firsts), schema }));
		const handler = toWebHandler(auth);

		const answer = await handler(
			requestTo("/sign-up", {
				body: { email: "r8@example.com", password: "a long enough password 1" },
			}),
		);

		expect(answer.status).toBeLessThan(500);
		expect(firsts.length).toBeGreaterThan(0);
		expect(firsts.filter((sql) => !sql.startsWith("SET TRANSACTION ISOLATION LEVEL READ"))).toEqual(
			[],
		);
	});
});
