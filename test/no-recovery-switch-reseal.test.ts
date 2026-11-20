import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SecurityStateMaintenanceError } from "../src/core/auth/security-state-maintenance.js";
import { checkSecurityState, readSecurityState } from "../src/core/security-state/read.js";
import { type MountedAuth, mountAuth, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";

/**
 * S-INTEG-11 against the administrator reseal and the maintenance step: a database writer who
 * clears `recovery_disabled_at` breaks the state, and neither a reseal nor the maintenance step
 * turns the switch off for him. A reseal refuses a switch the last seal was taken the other way
 * round unless the operator names the switch, writes the one the operator names, and reports the
 * switch it ratified like every other component.
 */

const PASSWORD = "correct-horse-battery-staple";
const REASON = "the account's alarm was investigated";
const keys = testKeyProvider();
let mounted: MountedAuth;
let accounts = 0;

beforeAll(async () => {
	mounted = await mountAuth("norecovery_reseal", {
		keys,
		rateLimit: {
			perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
			perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
		},
	});
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

async function signUp(): Promise<{ userId: string; email: string }> {
	accounts += 1;
	const email = `no-recovery-reseal-${accounts}@example.com`;
	const answer = await mounted.handler(postTo("/sign-up", { email, password: PASSWORD }));
	const userId = ((await answer.json()) as { user: { id: string } }).user.id;
	return { userId, email };
}

async function switchedOffAndClearedByAWriter(): Promise<{ userId: string; email: string }> {
	const account = await signUp();
	await mounted.auth.user.disableRecovery({ userId: account.userId });
	await mounted.connection.query(
		`UPDATE ${mounted.schema}.user SET recovery_disabled_at = NULL WHERE id = $1`,
		[account.userId],
	);
	return account;
}

async function stateOf(userId: string): Promise<{ verdict: string; recoveryDisabled: boolean }> {
	const read = await readSecurityState(mounted.connection, mounted.schema, userId);
	if (read === null) {
		throw new Error("the account is gone");
	}
	const { verdict } = await checkSecurityState(keys, read, "required");
	return { verdict, recoveryDisabled: read.recoveryDisabled };
}

async function sendsOfAResetRequest(email: string): Promise<readonly string[]> {
	await mounted.connection.query(`DELETE FROM ${mounted.schema}.rate_bucket`, []);
	mounted.email.clear();
	await mounted.handler(postTo("/password/request-reset", { email }));
	return mounted.email.kinds();
}

describe("the administrator reseal and a switch a writer cleared (S-INTEG-11)", () => {
	it("refuses to ratify the cleared switch and leaves the state broken", async () => {
		const account = await switchedOffAndClearedByAWriter();

		const reseal = mounted.auth.maintenance.resealSecurityState({
			userId: account.userId,
			reason: REASON,
		});

		await expect(reseal).rejects.toBeInstanceOf(SecurityStateMaintenanceError);
		await expect(reseal).rejects.toMatchObject({
			code: "security_state_recovery_switch_unconfirmed",
			userId: account.userId,
		});
		expect(await stateOf(account.userId)).toStrictEqual({
			verdict: "seal_mismatch",
			recoveryDisabled: false,
		});
	});

	it("writes the switch back on when the operator names it, and the mailed paths stay off", async () => {
		const account = await switchedOffAndClearedByAWriter();

		const ratified = await mounted.auth.maintenance.resealSecurityState({
			userId: account.userId,
			reason: REASON,
			recoveryDisabled: true,
		});

		expect(ratified.recoveryDisabled).toBe(true);
		expect(ratified.recoveryCodeCount).toBe(0);
		expect(await stateOf(account.userId)).toStrictEqual({
			verdict: "valid",
			recoveryDisabled: true,
		});
		expect(await sendsOfAResetRequest(account.email)).toStrictEqual([
			"request_for_unknown_address",
		]);
	});

	it("turns it off only when the operator says so, and reports what it ratified", async () => {
		const account = await switchedOffAndClearedByAWriter();

		const ratified = await mounted.auth.maintenance.resealSecurityState({
			userId: account.userId,
			reason: REASON,
			recoveryDisabled: false,
		});

		expect(ratified.recoveryDisabled).toBe(false);
		expect(await stateOf(account.userId)).toStrictEqual({
			verdict: "valid",
			recoveryDisabled: false,
		});
		expect(await sendsOfAResetRequest(account.email)).toStrictEqual(["password_reset"]);
	});

	it("refuses a switch a writer set as well, the other way round", async () => {
		const account = await signUp();
		await mounted.connection.query(
			`UPDATE ${mounted.schema}.user SET recovery_disabled_at = now() WHERE id = $1`,
			[account.userId],
		);

		await expect(
			mounted.auth.maintenance.resealSecurityState({ userId: account.userId, reason: REASON }),
		).rejects.toMatchObject({ code: "security_state_recovery_switch_unconfirmed" });
	});

	it("refuses a switch value that is not a boolean", async () => {
		const account = await switchedOffAndClearedByAWriter();

		await expect(
			mounted.auth.maintenance.resealSecurityState({
				userId: account.userId,
				reason: REASON,
				recoveryDisabled: "yes" as unknown as boolean,
			}),
		).rejects.toMatchObject({ code: "security_state_recovery_switch_unconfirmed" });
		expect((await stateOf(account.userId)).verdict).toBe("seal_mismatch");
	});

	it("ratifies a broken state that did not touch the switch as before, and reports the switch", async () => {
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
		expect(ratified.emailVerified).toBe(true);
		expect(await stateOf(account.userId)).toStrictEqual({
			verdict: "valid",
			recoveryDisabled: true,
		});
	});
});

describe("the maintenance step and the switch (S-INTEG-11, S-INTEG-8)", () => {
	it("keeps a switch that is on and refuses an account whose switch a writer cleared", async () => {
		const kept = await signUp();
		await mounted.auth.user.disableRecovery({ userId: kept.userId });
		const cleared = await switchedOffAndClearedByAWriter();

		const report = await mounted.auth.maintenance.sealSecurityState();

		expect(report.refusedUserIds).toContain(cleared.userId);
		expect(report.refusedUserIds).not.toContain(kept.userId);
		expect(await stateOf(kept.userId)).toStrictEqual({ verdict: "valid", recoveryDisabled: true });
		expect(await stateOf(cleared.userId)).toStrictEqual({
			verdict: "seal_mismatch",
			recoveryDisabled: false,
		});
	});
});
