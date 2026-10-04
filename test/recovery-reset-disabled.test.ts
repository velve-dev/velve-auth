import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createVelveAuth } from "../src/index.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { configFor } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { postTo } from "./flows-fixtures.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";

/**
 * A recovery code presented for a disabled account is answered as a wrong code, and it is spent:
 * the account may be disabled because it is compromised, and a code someone else presented must
 * not reset the password once the account is enabled again (E-2872).
 */

const PASSWORD = "correct-horse-battery-staple";
const REPLACEMENT = "a different password entirely";
const ADDRESS = "disabled-recovery@example.com";
const ONE_TOTP_STEP_IN_MILLISECONDS = 30_000;
const ROUTE = "/password/redeem-reset-with-recovery-code";

let connection: TestConnection;
let schema: string;
let clock: TestClock;
let auth: ReturnType<typeof createVelveAuth>;
let handler: (request: Request) => Promise<Response>;

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("recoverydisabled"));
	clock = createTestClock();
	auth = createVelveAuth(
		configFor({
			database: connection,
			schema,
			clock,
			rateLimit: {
				perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
				perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
			},
		}),
	);
	handler = toWebHandler(auth);
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

function sessionCookieOf(answer: Response): string {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === DEFAULT_COOKIE_NAMES.session) {
			return pair.slice(separator + 1);
		}
	}
	throw new Error(`the answer (${answer.status}) wrote no session cookie`);
}

function withSession(token: string): { Cookie: string } {
	return { Cookie: `${DEFAULT_COOKIE_NAMES.session}=${token}` };
}

async function codesOfANewAccount(): Promise<{ userId: string; codes: readonly string[] }> {
	const signedUp = await handler(postTo("/sign-up", { email: ADDRESS, password: PASSWORD }));
	expect(signedUp.status).toBe(200);
	const session = sessionCookieOf(signedUp);
	const started = await handler(postTo("/factor/totp/enroll/start", {}, withSession(session)));
	const { secretBase32 } = (await started.json()) as { secretBase32: string };
	const finished = await handler(
		postTo(
			"/factor/totp/enroll/finish",
			{ code: totpCodeForStep(secretBytesOfBase32(secretBase32), timeStepAt(clock.now())) },
			withSession(session),
		),
	);
	expect([started.status, finished.status]).toStrictEqual([200, 204]);
	clock.advanceBy(2 * ONE_TOTP_STEP_IN_MILLISECONDS);
	const generated = await handler(postTo("/factor/recovery/generate", {}, withSession(session)));
	expect(generated.status).toBe(200);
	const { codes } = (await generated.json()) as { codes: readonly string[] };
	const [row] = await connection.query<{ id: string }>(
		`SELECT id FROM ${schema}.user WHERE email = $1`,
		[ADDRESS],
	);
	return { userId: row?.id ?? "", codes };
}

async function remainingCodesOf(userId: string): Promise<number> {
	const [row] = await connection.query<{ total: number }>(
		`SELECT count(*)::integer AS total FROM ${schema}.recovery_code WHERE user_id = $1`,
		[userId],
	);
	return row?.total ?? -1;
}

async function errorCodeOf(answer: Response): Promise<string> {
	return ((await answer.json()) as { error: { code: string } }).error.code;
}

describe("a recovery-code reset on a disabled account", () => {
	it("answers as a wrong code does and leaves the code spent after the account is enabled", async () => {
		const { userId, codes } = await codesOfANewAccount();
		const [presented] = codes;
		const before = await remainingCodesOf(userId);
		const input = { email: ADDRESS, recoveryCode: presented, newPassword: REPLACEMENT };

		await auth.user.disable({ userId, reason: "the test disables it" });
		const whileDisabled = await handler(postTo(ROUTE, input));
		const wrongCode = await handler(postTo(ROUTE, { ...input, recoveryCode: "aaaaa-bbbbb" }));

		expect([whileDisabled.status, await errorCodeOf(whileDisabled)]).toStrictEqual([
			wrongCode.status,
			await errorCodeOf(wrongCode),
		]);
		expect(await remainingCodesOf(userId)).toBe(before - 1);

		await auth.user.enable({ userId });
		const afterEnable = await handler(postTo(ROUTE, input));

		expect(await errorCodeOf(afterEnable)).toBe("invalid_recovery_code");
		const signedIn = await handler(
			postTo("/sign-in/password", { email: ADDRESS, password: PASSWORD }),
		);
		expect(signedIn.status).toBe(200);
	});
});
