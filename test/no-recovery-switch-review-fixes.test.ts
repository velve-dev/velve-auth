import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import type { SecurityStateAlarm } from "../src/core/security-state/alarm.js";
import { checkSecurityState, readSecurityState } from "../src/core/security-state/read.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { type MountedAuth, mountAuth, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";

/**
 * Review of the answers to R1 to R4 (E-3746 to E-3748): a reseal of an account whose state the
 * seal confirms still needs no switch named, a reseal of an unconfirmed state with the switch off
 * needs it however the state was broken, and turning the switch on ends a sign-in waiting for its
 * second factor as a missing pending authentication, without an alarm, while a sign-in begun
 * afterwards completes.
 */

const PASSWORD = "correct-horse-battery-staple";
const REASON = "the alarm on this account was investigated";
const ONE_TOTP_STEP_IN_MILLISECONDS = 30_000;
const keys = testKeyProvider();
const alarms: SecurityStateAlarm[] = [];
let mounted: MountedAuth;
let clock: TestClock;
let accounts = 0;

beforeAll(async () => {
	clock = createTestClock();
	mounted = await mountAuth("norecovery_review_fixes", {
		keys,
		clock,
		securityState: { sealing: "required", alarm: (alarm) => alarms.push(alarm) },
		rateLimit: {
			perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
			perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
		},
	});
}, 120_000);

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

beforeEach(() => {
	alarms.length = 0;
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

async function signUp(): Promise<{ email: string; userId: string; sessionToken: string }> {
	accounts += 1;
	const email = `review-fixes-${accounts}@example.com`;
	const answer = await mounted.handler(postTo("/sign-up", { email, password: PASSWORD }));
	const sessionToken = cookieIn(answer, DEFAULT_COOKIE_NAMES.session);
	const body = (await answer.json()) as { user: { id: string } };
	if (answer.status !== 200 || sessionToken === null) {
		throw new Error(`the sign-up answered ${answer.status}`);
	}
	return { email, userId: body.user.id, sessionToken };
}

async function verdictOf(userId: string): Promise<string> {
	const read = await readSecurityState(mounted.connection, mounted.schema, userId);
	if (read === null) {
		throw new Error("the account is gone");
	}
	return (await checkSecurityState(keys, read, "required")).verdict;
}

describe("the reseal after E-3746", () => {
	it("still reseals a confirmed state without the switch named", async () => {
		const account = await signUp();

		const ratified = await mounted.auth.maintenance.resealSecurityState({
			userId: account.userId,
			reason: REASON,
		});

		expect(ratified.recoveryDisabled).toBe(false);
		expect(await verdictOf(account.userId)).toBe("valid");
	});

	it("asks for the switch when a writer deleted the seal row and cleared the switch", async () => {
		const account = await signUp();
		await mounted.auth.user.disableRecovery({ userId: account.userId });
		await mounted.connection.query(
			`UPDATE ${mounted.schema}.user SET recovery_disabled_at = NULL WHERE id = $1`,
			[account.userId],
		);
		await mounted.connection.query(
			`DELETE FROM ${mounted.schema}.security_state WHERE user_id = $1`,
			[account.userId],
		);

		await expect(
			mounted.auth.maintenance.resealSecurityState({ userId: account.userId, reason: REASON }),
		).rejects.toMatchObject({ code: "security_state_recovery_switch_unconfirmed" });
		const named = await mounted.auth.maintenance.resealSecurityState({
			userId: account.userId,
			reason: REASON,
			recoveryDisabled: true,
		});

		expect(named.recoveryDisabled).toBe(true);
		expect(await verdictOf(account.userId)).toBe("valid");
	});

	it("keeps a switch that is on in a broken state and leaves no code under it", async () => {
		const account = await signUp();
		await mounted.auth.user.disableRecovery({ userId: account.userId });
		await mounted.connection.query(
			`UPDATE ${mounted.schema}.user SET email_verified_at = now() WHERE id = $1`,
			[account.userId],
		);

		const ratified = await mounted.auth.maintenance.resealSecurityState({
			userId: account.userId,
			reason: REASON,
		});

		expect(ratified.recoveryDisabled).toBe(true);
		expect(ratified.recoveryCodeCount).toBe(0);
	});
});

describe("turning the switch on ends a sign-in waiting for its second factor (E-3747)", () => {
	it("answers as a missing pending authentication, raises no alarm, and a new sign-in completes", async () => {
		const account = await signUp();
		const session = { Cookie: `${DEFAULT_COOKIE_NAMES.session}=${account.sessionToken}` };
		const started = await mounted.handler(postTo("/factor/totp/enroll/start", {}, session));
		const { secretBase32 } = (await started.json()) as { secretBase32: string };
		const code = () => totpCodeForStep(secretBytesOfBase32(secretBase32), timeStepAt(clock.now()));
		await mounted.handler(postTo("/factor/totp/enroll/finish", { code: code() }, session));
		clock.advanceBy(2 * ONE_TOTP_STEP_IN_MILLISECONDS);
		const before = await mounted.handler(
			postTo("/sign-in/password", { email: account.email, password: PASSWORD }),
		);
		const pendingBefore = cookieIn(before, DEFAULT_COOKIE_NAMES.pending);
		if (pendingBefore === null) {
			throw new Error("the sign-in asked for no second factor");
		}

		await mounted.auth.user.disableRecovery({ userId: account.userId });
		const ended = await mounted.handler(
			postTo(
				"/factor/totp/verify",
				{ code: code() },
				{ Cookie: `${DEFAULT_COOKIE_NAMES.pending}=${pendingBefore}` },
			),
		);
		const after = await mounted.handler(
			postTo("/sign-in/password", { email: account.email, password: PASSWORD }),
		);
		const pendingAfter = cookieIn(after, DEFAULT_COOKIE_NAMES.pending) ?? "";
		const completed = await mounted.handler(
			postTo(
				"/factor/totp/verify",
				{ code: code() },
				{ Cookie: `${DEFAULT_COOKIE_NAMES.pending}=${pendingAfter}` },
			),
		);

		expect(ended.status).toBe(401);
		expect(((await ended.json()) as { error: { code: string } }).error.code).toBe(
			"invalid_pending_authentication",
		);
		expect(completed.status).toBe(200);
		expect(cookieIn(completed, DEFAULT_COOKIE_NAMES.session)).not.toBeNull();
		expect(alarms).toStrictEqual([]);
	});
});
