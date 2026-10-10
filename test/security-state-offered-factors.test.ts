import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createVelveAuth } from "../src/index.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { configFor, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { postTo } from "./flows-fixtures.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";

//a writer who removes the confirmed totp row between the seal check and the pending insert must not get a password-only session (S-INTEG-4)

const PASSWORD = "a password long enough for the policy 3d9a";

let connection: TestConnection;
let schema: string;
let clock: TestClock;
let handler: (request: Request) => Promise<Response>;
let strikeBeforePendingInsert: (() => Promise<void>) | null = null;

function intercepting(driver: Driver): Driver {
	return {
		async query<R>(sql: string, params: unknown[]): Promise<R[]> {
			if (
				strikeBeforePendingInsert !== null &&
				sql.includes("INSERT INTO") &&
				sql.includes("pending_authentication")
			) {
				const strike = strikeBeforePendingInsert;
				strikeBeforePendingInsert = null;
				await strike();
			}
			return driver.query<R>(sql, params);
		},
		transaction<R>(work: (tx: Driver) => Promise<R>): Promise<R> {
			return driver.transaction((tx) => work(intercepting(tx)));
		},
	};
}

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("offered_factors"));
	clock = createTestClock();
	const auth = createVelveAuth(
		configFor({
			database: intercepting(connection),
			schema,
			keys: testKeyProvider(),
			clock,
			securityState: { sealing: "required" },
			rateLimit: {
				perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
				perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
			},
		}),
	);
	handler = toWebHandler(auth);
}, 120_000);

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

function cookieIn(answer: Response, name: string): string | null {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === name) {
			const value = pair.slice(separator + 1);
			return value === "" ? null : value;
		}
	}
	return null;
}

function withSession(token: string): Record<string, string> {
	return { Cookie: `${DEFAULT_COOKIE_NAMES.session}=${token}` };
}

describe("the second factors a sign-in offers come from its verified read (S-INTEG-4)", () => {
	it("refuses the sign-in like a wrong password when the TOTP row vanishes after the check", async () => {
		const email = "downgrade@example.com";
		const signedUp = await handler(postTo("/sign-up", { email, password: PASSWORD }));
		expect(signedUp.status).toBe(200);
		const userId = ((await signedUp.json()) as { user: { id: string } }).user.id;
		const session = cookieIn(signedUp, DEFAULT_COOKIE_NAMES.session) ?? "";
		const started = await handler(postTo("/factor/totp/enroll/start", {}, withSession(session)));
		const { secretBase32 } = (await started.json()) as { secretBase32: string };
		const code = totpCodeForStep(secretBytesOfBase32(secretBase32), timeStepAt(clock.now()));
		const finished = await handler(
			postTo("/factor/totp/enroll/finish", { code }, withSession(session)),
		);
		expect(finished.status).toBe(204);

		const [saved] = await connection.query<Record<string, unknown>>(
			`SELECT * FROM ${schema}.totp_credential WHERE user_id = $1`,
			[userId],
		);
		strikeBeforePendingInsert = async () => {
			await connection.query(`DELETE FROM ${schema}.totp_credential WHERE user_id = $1`, [userId]);
		};
		const answer = await handler(postTo("/sign-in/password", { email, password: PASSWORD }));
		const body = (await answer.json()) as { error?: { code?: string } };
		await connection.query(
			`INSERT INTO ${schema}.totp_credential (user_id, secret_enc, key_version, confirmed_at, created_at)
VALUES ($1, $2, $3, $4, $5)`,
			[userId, saved?.secret_enc, saved?.key_version, saved?.confirmed_at, saved?.created_at],
		);
		const stolen = cookieIn(answer, DEFAULT_COOKIE_NAMES.session);
		const resolved =
			stolen === null
				? null
				: await handler(
						new Request("https://api.example.com/session", {
							method: "GET",
							headers: {
								Cookie: `${DEFAULT_COOKIE_NAMES.session}=${stolen}`,
								Origin: "https://app.example.com",
							},
						}),
					);

		expect({
			status: answer.status,
			code: body.error?.code,
			session: stolen,
			pending: cookieIn(answer, DEFAULT_COOKIE_NAMES.pending),
			resolved,
		}).toStrictEqual({
			status: 401,
			code: "invalid_credentials",
			session: null,
			pending: null,
			resolved: null,
		});
	});
});
