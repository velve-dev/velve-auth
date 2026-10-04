import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createVelveAuth } from "../src/index.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { configFor } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";

type Handler = (request: Request) => Promise<Response>;
type Connection = Awaited<ReturnType<typeof openMigratedSchema>>["connection"];

const ROUTE = "/password/redeem-reset-with-recovery-code";
const ROUTE_NAME = "password.redeemResetWithRecoveryCode";
const ACCOUNT = { capacity: 2, refillPerSecond: 0.01 };
const ADDRESS = "rightful.owner@example.com";
const PASSWORD = "correct-horse-battery-staple";
const REPLACEMENT = "a different password entirely";
const WRONG_CODE = "aaaaa-bbbbb";

function sessionCookieOf(answer: Response): string {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		if (pair.slice(0, pair.indexOf("=")) === DEFAULT_COOKIE_NAMES.session) {
			return pair;
		}
	}
	throw new Error("the answer carried no session cookie");
}

async function codeOf(answer: Response): Promise<string> {
	return ((await answer.json()) as { error: { code: string } }).error.code;
}

/**
 * T-RATE-7's remaining thresholds on the recovery-code reset: a full bucket refuses even the
 * correct code rather than locking the account, the owner gets in once it has refilled, and the
 * identifier is never written into the bucket key in plaintext.
 */
describe("the recovery-code reset refuses rather than locks, and refills for the owner (S-RATE-7)", () => {
	let mount: { connection: Connection; schema: string; handler: Handler; clock: TestClock };
	let codes: readonly string[];

	beforeAll(async () => {
		const { connection, schema } = await openMigratedSchema("recoveryrefill");
		const clock = createTestClock(new Date());
		const auth = createVelveAuth(
			configFor({
				database: connection,
				schema,
				clock,
				rateLimit: {
					perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
					perAccount: ACCOUNT,
				},
			}),
		);
		mount = { connection, schema, handler: toWebHandler(auth), clock };

		const created = await mount.handler(postTo("/sign-up", { email: ADDRESS, password: PASSWORD }));
		expect(created.status).toBe(200);
		const generated = await mount.handler(
			postTo("/factor/recovery/generate", {}, { Cookie: sessionCookieOf(created) }),
		);
		expect(generated.status).toBe(200);
		codes = ((await generated.json()) as { codes: readonly string[] }).codes;
	});

	afterAll(async () => {
		await dropSchema(mount.connection, mount.schema);
		await mount.connection.close();
	});

	function redeem(recoveryCode: string): Promise<Response> {
		return mount.handler(postTo(ROUTE, { email: ADDRESS, recoveryCode, newPassword: REPLACEMENT }));
	}

	it("refuses a correct code once the bucket is empty and admits it after the refill time", async () => {
		const failed: string[] = [];
		for (let attempt = 0; attempt < ACCOUNT.capacity; attempt += 1) {
			failed.push(await codeOf(await redeem(WRONG_CODE)));
		}
		expect(failed).toEqual(Array(ACCOUNT.capacity).fill("invalid_recovery_code"));

		const refused = await redeem(codes[0] ?? "");
		expect(refused.status).toBe(429);
		expect(await codeOf(refused)).toBe("rate_limited");

		mount.clock.advanceBy((ACCOUNT.capacity / ACCOUNT.refillPerSecond) * 1000);
		const admitted = await redeem(codes[0] ?? "");

		expect(admitted.status).toBe(200);
	});

	it("writes no part of the identifier into the route's bucket key", async () => {
		const rows = await mount.connection.query<{ bucket_key: string }>(
			`SELECT bucket_key FROM ${mount.schema}.rate_bucket WHERE starts_with(bucket_key, $1)`,
			[`account|${ROUTE_NAME}|`],
		);

		expect(rows).toHaveLength(1);
		for (const fragment of ["rightful", "owner", "example", "@"]) {
			expect(rows[0]?.bucket_key).not.toContain(fragment);
		}
	});
});
