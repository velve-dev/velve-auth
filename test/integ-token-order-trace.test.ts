import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import type { Driver } from "../src/core/db/driver.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, requestTo } from "./auth-fixtures.js";
import { dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";

/**
 * CLAUDE.md section 7 orders `velve.one_time_token` before `velve.user` everywhere: no transaction
 * that takes the account row touches the token table afterwards. `check:token-after-lock` reads
 * one file at a time, and a flow that issues a session takes the account lock in the session
 * repository, a file away from where it mints. This traces every statement of every transaction
 * the email flows and the sign-up open, and refuses a token-table statement after the lock (E-3254).
 */

let migrated: MigratedSchema;
let handler: (request: Request) => Promise<Response>;
const transactions: string[][] = [];
const mailed: EmailMessage[] = [];

function tracing(driver: Driver, trace: string[] | null): Driver {
	return {
		query: (sql, params) => {
			trace?.push(sql.replace(/\s+/g, " "));
			return driver.query(sql, params);
		},
		transaction: (work) =>
			driver.transaction((tx) => {
				//a nested transaction is a savepoint of the outer one and shares its trace
				const inner = trace ?? [];
				if (trace === null) {
					transactions.push(inner);
				}
				return work(tracing(tx, inner));
			}),
	};
}

function tokenMailed(kind: EmailMessage["kind"]): string {
	const message = mailed.filter((candidate) => candidate.kind === kind).at(-1);
	if (message === undefined || !("token" in message)) {
		throw new Error(`no ${kind} message carrying a token`);
	}
	return message.token;
}

function cookieOf(answer: Response): string {
	const value = /__Host-velve_session=([^;]*)/.exec(answer.headers.get("Set-Cookie") ?? "")?.[1];
	if (value === undefined || value === "") {
		throw new Error("no session cookie");
	}
	return `__Host-velve_session=${value}`;
}

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
	const answer = await handler(
		requestTo(path, { body, ...(cookie === undefined ? {} : { cookie }) }),
	);
	expect(answer.status, path).toBeLessThan(300);
	return answer;
}

//every transaction the library opens names its isolation first (E-3310)
function transactionsNotOpenedAtReadCommitted(): string[] {
	return transactions
		.map((trace) => trace[0] ?? "")
		.filter((first) => !first.startsWith("SET TRANSACTION ISOLATION LEVEL READ COMMITTED"));
}

function tokenStatementsAfterTheAccountLock(): string[][] {
	return transactions.filter((trace) => {
		const lock = trace.findIndex((sql) => sql.includes("FOR NO KEY UPDATE"));
		return lock >= 0 && trace.slice(lock + 1).some((sql) => sql.includes(".one_time_token"));
	});
}

beforeAll(async () => {
	migrated = await openMigratedSchema("token_order_trace");
	handler = toWebHandler(
		createVelveAuth(
			configFor({
				database: tracing(migrated.connection, null),
				schema: migrated.schema,
				email: {
					send: async (message) => {
						mailed.push(message);
					},
				},
				rateLimit: {
					perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
					perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
				},
			}),
		),
	);
});

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

describe("velve.one_time_token before velve.user, at READ COMMITTED, in every flow that mints or redeems and issues (CLAUDE.md section 7)", () => {
	const ADDRESS = "order@example.com";
	const PASSWORD = "correct-horse-battery-staple";
	let cookie: string;

	it("holds for the sign-up, which mints the verification token and issues the session", async () => {
		transactions.length = 0;
		cookie = cookieOf(await post("/sign-up", { email: ADDRESS, password: PASSWORD }));

		expect(
			transactions.some((trace) => trace.some((sql) => sql.includes("FOR NO KEY UPDATE"))),
		).toBe(true);
		expect(tokenStatementsAfterTheAccountLock()).toStrictEqual([]);
		expect(transactionsNotOpenedAtReadCommitted()).toStrictEqual([]);
	});

	it("holds for the verification resent and redeemed", async () => {
		transactions.length = 0;
		await post("/email/request-verification", {}, cookie);
		await post("/email/redeem-verification", { token: tokenMailed("email_verification") });

		expect(tokenStatementsAfterTheAccountLock()).toStrictEqual([]);
		expect(transactionsNotOpenedAtReadCommitted()).toStrictEqual([]);
	});

	it("holds for the magic link requested and redeemed", async () => {
		transactions.length = 0;
		await post("/sign-in/magic-link/request", { email: ADDRESS });
		cookie = cookieOf(
			await post("/sign-in/magic-link/redeem", { token: tokenMailed("magic_link") }),
		);

		expect(tokenStatementsAfterTheAccountLock()).toStrictEqual([]);
		expect(transactionsNotOpenedAtReadCommitted()).toStrictEqual([]);
	});

	it("holds for the address change requested and redeemed", async () => {
		transactions.length = 0;
		await post("/email/request-change", { newEmail: "moved@example.com" }, cookie);
		await post("/email/redeem-change", { token: tokenMailed("email_change") });

		expect(tokenStatementsAfterTheAccountLock()).toStrictEqual([]);
		expect(transactionsNotOpenedAtReadCommitted()).toStrictEqual([]);
	});

	it("holds for the password reset requested and redeemed", async () => {
		transactions.length = 0;
		await post("/password/request-reset", { email: "moved@example.com" });
		await post("/password/redeem-reset", {
			token: tokenMailed("password_reset"),
			newPassword: "another-horse-battery-staple",
		});

		expect(
			transactions.some((trace) => trace.some((sql) => sql.includes("FOR NO KEY UPDATE"))),
		).toBe(true);
		expect(tokenStatementsAfterTheAccountLock()).toStrictEqual([]);
		expect(transactionsNotOpenedAtReadCommitted()).toStrictEqual([]);
	});
});
