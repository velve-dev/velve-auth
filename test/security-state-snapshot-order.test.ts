import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import type { Driver } from "../src/core/db/driver.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, requestTo } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";

// Section 3.18 *Sealing* puts the consumption first where CLAUDE.md section 7 and E-1616 do, and
// the account lock after it. Resetting the password is such a change: it consumes its one-time
// token before it reaches the account lock. The case records every statement the library sends to
// the database while a reset is redeemed and holds that order there, not in the source text, and
// that the transaction states READ COMMITTED right before the consumption (E-3310, E-3327). Its
// earlier comment and title described the snapshot rule of E-3209, which E-3280 abandoned (E-3302).

let connection: TestConnection;
let schema: string;
const statements: string[] = [];

function recording(driver: Driver): Driver {
	return {
		query<T>(sql: string, params: unknown[]): Promise<T[]> {
			statements.push(sql);
			return driver.query<T>(sql, params);
		},
		transaction<T>(work: (tx: Driver) => Promise<T>): Promise<T> {
			return driver.transaction((tx) => work(recording(tx)));
		},
	};
}

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("consumption_order"));
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

function firstIndexOf(pattern: RegExp): number {
	return statements.findIndex((sql) => pattern.test(sql.replace(/\s+/g, " ")));
}

describe("the order of consumption and account lock in a sealing change (section 3.18, Sealing)", () => {
	it("consumes the reset token before it reaches the account lock, as sent to the database", async () => {
		const mailed: EmailMessage[] = [];
		const handler = toWebHandler(
			createVelveAuth(
				configFor({
					database: recording(connection),
					schema,
					email: { send: async (message: EmailMessage) => void mailed.push(message) },
				}),
			),
		);
		const signedUp = await handler(
			requestTo("/sign-up", {
				body: { email: "order@example.com", password: "a password long enough 1" },
			}),
		);
		expect(signedUp.status).toBe(200);
		await handler(requestTo("/password/request-reset", { body: { email: "order@example.com" } }));
		const reset = mailed.at(-1) as EmailMessage & { token: string };
		expect(reset?.kind).toBe("password_reset");

		statements.length = 0;
		const redeemed = await handler(
			requestTo("/password/redeem-reset", {
				body: { token: reset.token, newPassword: "another password long enough 2" },
			}),
		);
		expect(redeemed.status).toBe(200);

		const consumedAt = firstIndexOf(/DELETE FROM \S*one_time_token/i);
		const lockedAt = firstIndexOf(/FOR NO KEY UPDATE/i);
		expect(consumedAt).toBeGreaterThan(-1);
		expect(lockedAt).toBeGreaterThan(-1);
		expect(consumedAt).toBeLessThan(lockedAt);
		expect(firstIndexOf(/SET TRANSACTION ISOLATION LEVEL READ COMMITTED/)).toBe(consumedAt - 1);
	});
});
