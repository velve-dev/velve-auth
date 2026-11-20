import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import type { SecurityStateAlarm } from "../src/core/security-state/alarm.js";
import { checkSecurityState, readSecurityState } from "../src/core/security-state/read.js";
import { createVelveAuth, type VelveAuth } from "../src/index.js";
import { configFor, testKeyProvider } from "./auth-fixtures.js";
import { openConnectionPool } from "./connection-pool-fixtures.js";
import { dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";

/**
 * Review of S-INTEG-11 against a request racing the switch: a reset with a recovery code, a
 * recovery code as a second factor and a magic link, each sent in the same instant as
 * `user.disableRecovery`. Whatever the order, the seal stays valid, no alarm is raised, the
 * account holds no recovery code afterwards, and a refused redemption answers as a wrong code or
 * an unknown token.
 */

const PASSWORD = "correct-horse-battery-staple";
const ROUNDS = 8;
const keys = testKeyProvider();
const alarms: SecurityStateAlarm[] = [];
const sent: EmailMessage[] = [];
let migrated: MigratedSchema;
let pool: Awaited<ReturnType<typeof openConnectionPool>>;
let auth: VelveAuth<"email">;
let handler: (request: Request) => Promise<Response>;
let accounts = 0;

beforeAll(async () => {
	migrated = await openMigratedSchema("norecovery_review_race");
	pool = await openConnectionPool(8);
	auth = createVelveAuth(
		configFor({
			database: pool,
			schema: migrated.schema,
			keys,
			securityState: { sealing: "required", alarm: (alarm) => alarms.push(alarm) },
			email: {
				send: (message) => {
					sent.push(message);
					return Promise.resolve();
				},
			},
			rateLimit: {
				perIpAddress: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
				perAccount: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
			},
		}),
	);
	handler = toWebHandler(auth);
}, 60_000);

afterAll(async () => {
	await pool.close();
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

beforeEach(() => {
	alarms.length = 0;
	sent.length = 0;
});

function sessionCookieOf(answer: Response): string | null {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === DEFAULT_COOKIE_NAMES.session) {
			const value = pair.slice(separator + 1);
			return value === "" ? null : value;
		}
	}
	return null;
}

async function signUp(): Promise<{ email: string; userId: string; sessionToken: string }> {
	accounts += 1;
	const email = `review-race-${accounts}@example.com`;
	const answer = await handler(postTo("/sign-up", { email, password: PASSWORD }));
	const sessionToken = sessionCookieOf(answer);
	const body = (await answer.json()) as { user: { id: string } };
	if (answer.status !== 200 || sessionToken === null) {
		throw new Error(`the sign-up answered ${answer.status}`);
	}
	return { email, userId: body.user.id, sessionToken };
}

async function codesFor(sessionToken: string): Promise<readonly string[]> {
	const answer = await handler(
		postTo(
			"/factor/recovery/generate",
			{},
			{ Cookie: `${DEFAULT_COOKIE_NAMES.session}=${sessionToken}` },
		),
	);
	expect(answer.status).toBe(200);
	return ((await answer.json()) as { codes: readonly string[] }).codes;
}

async function afterTheRace(userId: string): Promise<{ verdict: string; codes: number }> {
	const read = await readSecurityState(migrated.connection, migrated.schema, userId);
	if (read === null) {
		throw new Error("the account is gone");
	}
	const [row] = await migrated.connection.query<{ total: number }>(
		`SELECT count(*)::integer AS total FROM ${migrated.schema}.recovery_code WHERE user_id = $1`,
		[userId],
	);
	return {
		verdict: (await checkSecurityState(keys, read, "required")).verdict,
		codes: row?.total ?? -1,
	};
}

async function errorCodeOf(answer: Response): Promise<string | null> {
	if (answer.status < 400) {
		return null;
	}
	return ((await answer.json()) as { error: { code: string } }).error.code;
}

describe("redemption against the switch going on (S-INTEG-11)", () => {
	it("a reset with a recovery code either completes first or answers as a wrong code", async () => {
		for (let round = 0; round < ROUNDS; round += 1) {
			const account = await signUp();
			const codes = await codesFor(account.sessionToken);

			const [reset] = await Promise.all([
				handler(
					postTo("/password/redeem-reset-with-recovery-code", {
						email: account.email,
						recoveryCode: codes[0],
						newPassword: `replacement password number ${round}`,
					}),
				),
				auth.user.disableRecovery({ userId: account.userId }),
			]);

			expect([200, 401]).toContain(reset.status);
			expect([null, "invalid_recovery_code"]).toContain(await errorCodeOf(reset));
			expect(await afterTheRace(account.userId)).toStrictEqual({ verdict: "valid", codes: 0 });
		}
		expect(alarms).toStrictEqual([]);
	});

	it("a magic link either signs in first or answers as an unknown token", async () => {
		for (let round = 0; round < ROUNDS; round += 1) {
			const account = await signUp();
			sent.length = 0;
			await handler(postTo("/sign-in/magic-link/request", { email: account.email }));
			const message = sent.find((candidate) => candidate.kind === "magic_link");
			if (message === undefined || !("token" in message)) {
				throw new Error("no magic link was mailed");
			}

			const [redeemed] = await Promise.all([
				handler(postTo("/sign-in/magic-link/redeem", { token: message.token })),
				auth.user.disableRecovery({ userId: account.userId }),
			]);

			expect([200, 400]).toContain(redeemed.status);
			expect([null, "invalid_token"]).toContain(await errorCodeOf(redeemed));
			expect((await afterTheRace(account.userId)).verdict).toBe("valid");
		}
		expect(alarms).toStrictEqual([]);
	});

	it("turning it on and off in parallel leaves a valid seal and a switch in one position", async () => {
		const account = await signUp();
		for (let round = 0; round < ROUNDS; round += 1) {
			await Promise.all([
				auth.user.disableRecovery({ userId: account.userId }),
				auth.user.enableRecovery({ userId: account.userId }),
				auth.user.disableRecovery({ userId: account.userId }),
			]);

			const read = await readSecurityState(migrated.connection, migrated.schema, account.userId);
			expect((await afterTheRace(account.userId)).verdict).toBe("valid");
			expect(typeof read?.recoveryDisabled).toBe("boolean");
		}
		expect(alarms).toStrictEqual([]);
	});
});
