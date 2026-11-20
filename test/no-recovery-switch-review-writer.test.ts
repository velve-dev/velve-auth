import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import type { SecurityStateAlarm } from "../src/core/security-state/alarm.js";
import { checkSecurityState, readSecurityState } from "../src/core/security-state/read.js";
import { createSecretToken, hashSecretToken } from "../src/core/token/secret-token.js";
import { createVelveAuth, type VelveAuth, type VelvePlugin } from "../src/index.js";
import { configFor, type MountedAuth, mountAuth, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import { type MemoryAnchor, memoryAnchor } from "./security-state-administration-fixtures.js";

/**
 * Review of S-INTEG-11 against a writer of the database who holds no root key and wants the
 * no-recovery switch off: he clears the column, restores the recovery-code rows the switch
 * deleted, copies another account's seal, plants a link row, plays the whole state back, and then
 * waits for an administrator reseal or the maintenance step to make his change the truth. The
 * requirement is that a write to the database alone cannot turn the switch off, and that while
 * the switch is on the account holds no recovery code.
 */

const PASSWORD = "correct-horse-battery-staple";
const REPLACEMENT = "a different password entirely";
const REASON = "the alarm on this account was investigated";
const keys = testKeyProvider();
const alarms: SecurityStateAlarm[] = [];
let mounted: MountedAuth;
let accounts = 0;

beforeAll(async () => {
	mounted = await mountAuth("norecovery_review_writer", {
		keys,
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

interface Account {
	readonly email: string;
	readonly userId: string;
	readonly sessionToken: string;
}

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

async function signUp(): Promise<Account> {
	accounts += 1;
	const email = `review-writer-${accounts}@example.com`;
	const answer = await mounted.handler(postTo("/sign-up", { email, password: PASSWORD }));
	const sessionToken = sessionCookieOf(answer);
	const body = (await answer.json()) as { user: { id: string } };
	if (answer.status !== 200 || sessionToken === null) {
		throw new Error(`the sign-up answered ${answer.status}`);
	}
	return { email, userId: body.user.id, sessionToken };
}

async function generateCodes(account: Account): Promise<readonly string[]> {
	const answer = await mounted.handler(
		postTo(
			"/factor/recovery/generate",
			{},
			{ Cookie: `${DEFAULT_COOKIE_NAMES.session}=${account.sessionToken}` },
		),
	);
	expect(answer.status).toBe(200);
	return ((await answer.json()) as { codes: readonly string[] }).codes;
}

async function savedCodeRows(userId: string): Promise<string> {
	const table = `saved_codes_${randomBytes(4).toString("hex")}`;
	await mounted.connection.query(
		`CREATE TABLE ${mounted.schema}.${table} AS SELECT * FROM ${mounted.schema}.recovery_code WHERE user_id = $1`,
		[userId],
	);
	return table;
}

async function restoreCodeRows(table: string): Promise<void> {
	await mounted.connection.query(
		`INSERT INTO ${mounted.schema}.recovery_code SELECT * FROM ${mounted.schema}.${table}`,
		[],
	);
}

async function clearTheSwitch(userId: string): Promise<void> {
	await mounted.connection.query(
		`UPDATE ${mounted.schema}.user SET recovery_disabled_at = NULL WHERE id = $1`,
		[userId],
	);
}

async function codeRowsOf(userId: string): Promise<number> {
	const [row] = await mounted.connection.query<{ total: number }>(
		`SELECT count(*)::integer AS total FROM ${mounted.schema}.recovery_code WHERE user_id = $1`,
		[userId],
	);
	return row?.total ?? -1;
}

async function verdictOf(userId: string): Promise<string> {
	const read = await readSecurityState(mounted.connection, mounted.schema, userId);
	if (read === null) {
		throw new Error("the account is gone");
	}
	return (await checkSecurityState(keys, read, "required")).verdict;
}

async function resetWithCode(account: Account, code: string): Promise<Response> {
	return mounted.handler(
		postTo("/password/redeem-reset-with-recovery-code", {
			email: account.email,
			recoveryCode: code,
			newPassword: REPLACEMENT,
		}),
	);
}

async function switchedOffWithItsOldCodesSaved(): Promise<{
	account: Account;
	codes: readonly string[];
	saved: string;
}> {
	const account = await signUp();
	const codes = await generateCodes(account);
	const saved = await savedCodeRows(account.userId);
	await mounted.auth.user.disableRecovery({ userId: account.userId });
	expect(await codeRowsOf(account.userId)).toBe(0);
	return { account, codes, saved };
}

describe("a writer who clears the switch and restores the deleted recovery codes (S-INTEG-11)", () => {
	it("cannot redeem a restored code while the state is broken", async () => {
		const { account, codes, saved } = await switchedOffWithItsOldCodesSaved();
		await clearTheSwitch(account.userId);
		await restoreCodeRows(saved);

		const answer = await resetWithCode(account, codes[0] ?? "");

		expect(answer.status).toBe(401);
		expect(await verdictOf(account.userId)).toBe("seal_mismatch");
		expect(alarms.map((alarm) => alarm.reason)).toContain("seal_mismatch");
	});

	it("is not given the switch off by an administrator reseal that does not name the switch", async () => {
		const { account, saved } = await switchedOffWithItsOldCodesSaved();
		await clearTheSwitch(account.userId);
		await restoreCodeRows(saved);

		const reseal = mounted.auth.maintenance.resealSecurityState({
			userId: account.userId,
			reason: REASON,
		});

		await expect(reseal).rejects.toMatchObject({
			code: "security_state_recovery_switch_unconfirmed",
		});
		expect(await verdictOf(account.userId)).toBe("seal_mismatch");
	});

	it("is refused by the maintenance step", async () => {
		const { account, saved } = await switchedOffWithItsOldCodesSaved();
		await clearTheSwitch(account.userId);
		await restoreCodeRows(saved);

		const report = await mounted.auth.maintenance.sealSecurityState();

		expect(report.refusedUserIds).toContain(account.userId);
		expect(await verdictOf(account.userId)).toBe("seal_mismatch");
	});
});

describe("a writer who restores the deleted recovery codes and leaves the switch on (S-INTEG-11)", () => {
	it("does not get a switched-off account that holds codes out of an administrator reseal", async () => {
		const { account, saved } = await switchedOffWithItsOldCodesSaved();
		await restoreCodeRows(saved);

		const ratified = await mounted.auth.maintenance.resealSecurityState({
			userId: account.userId,
			reason: REASON,
		});

		expect(ratified.recoveryDisabled).toBe(true);
		expect(ratified.recoveryCodeCount).toBe(0);
		expect(await codeRowsOf(account.userId)).toBe(0);
	});

	it("does not get the old codes back once the owner turns recovery on again", async () => {
		const { account, codes, saved } = await switchedOffWithItsOldCodesSaved();
		await restoreCodeRows(saved);
		await mounted.auth.maintenance
			.resealSecurityState({ userId: account.userId, reason: REASON })
			.catch(() => null);
		await mounted.auth.user.enableRecovery({ userId: account.userId }).catch(() => null);

		const answer = await resetWithCode(account, codes[1] ?? "");

		expect(answer.status).toBe(401);
	});
});

describe("a writer who copies another account's seal onto a cleared switch (S-INTEG-11)", () => {
	it("still meets a broken state", async () => {
		const victim = await signUp();
		const donor = await signUp();
		await mounted.auth.user.disableRecovery({ userId: victim.userId });
		await clearTheSwitch(victim.userId);
		await mounted.connection.query(
			`UPDATE ${mounted.schema}.security_state AS victim
			SET version = donor.version, digest = donor.digest, key_version = donor.key_version,
				session_epoch = donor.session_epoch, components_version = donor.components_version
			FROM ${mounted.schema}.security_state AS donor
			WHERE victim.user_id = $1 AND donor.user_id = $2`,
			[victim.userId, donor.userId],
		);

		const signIn = await mounted.handler(
			postTo("/sign-in/password", { email: victim.email, password: PASSWORD }),
		);

		expect(signIn.status).toBe(401);
		expect(await verdictOf(victim.userId)).toBe("seal_mismatch");
	});
});

describe("a writer who plants a reset row for a switched-off account (S-INTEG-11, S-INTEG-9)", () => {
	it("gets no password written, before and after the maintenance step", async () => {
		const account = await signUp();
		await mounted.auth.user.disableRecovery({ userId: account.userId });
		const token = createSecretToken();
		const [generation] = await mounted.connection.query<{ generation: string }>(
			`SELECT password_reset_generation::text AS generation FROM ${mounted.schema}.security_state WHERE user_id = $1`,
			[account.userId],
		);
		await mounted.connection.query(
			`INSERT INTO ${mounted.schema}.one_time_token
				(token_sha256, purpose, user_id, payload, expires_at, token_mac, token_mac_key_version)
			VALUES ($1, 'password_reset', $2, $3, now() + interval '1 hour', $4, 1)`,
			[
				hashSecretToken(token),
				account.userId,
				JSON.stringify({
					accountEmail: account.email,
					tokenGeneration: Number(generation?.generation ?? 1),
				}),
				randomBytes(32),
			],
		);

		await mounted.auth.maintenance.sealSecurityState();
		const answer = await mounted.handler(
			postTo("/password/redeem-reset", { token, newPassword: REPLACEMENT }),
		);
		const signIn = await mounted.handler(
			postTo("/sign-in/password", { email: account.email, password: PASSWORD }),
		);

		expect(answer.status).toBe(400);
		expect(((await answer.json()) as { error: { code: string } }).error.code).toBe("invalid_token");
		expect(signIn.status).toBe(200);
		expect(await verdictOf(account.userId)).toBe("valid");
	});
});

describe("a writer who plays the whole state back to before the switch went on (S-INTEG-6)", () => {
	function mountedWithAnchor(anchor: MemoryAnchor): VelveAuth<"email"> {
		const plugins: VelvePlugin[] = [{ id: "anchor", securityStateAnchor: anchor.anchor }];
		return createVelveAuth(
			configFor({
				database: mounted.connection,
				schema: mounted.schema,
				keys,
				plugins,
				securityState: { sealing: "required", alarm: (alarm) => alarms.push(alarm) },
				rateLimit: {
					perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
					perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
				},
			}),
		);
	}

	it("is refused with an anchor, so the switch stays on", async () => {
		const anchor = memoryAnchor();
		const anchored = mountedWithAnchor(anchor);
		accounts += 1;
		const email = `review-writer-${accounts}@example.com`;
		const signedUp = await anchored.signUp.withPassword({
			email,
			password: PASSWORD,
			origin: "https://app.example.com",
		});
		const account = { email, userId: signedUp.user.id, sessionToken: signedUp.sessionToken };
		const codes = await generateCodes(account);
		const savedCodes = await savedCodeRows(account.userId);
		const savedSeal = `saved_seal_${randomBytes(4).toString("hex")}`;
		await mounted.connection.query(
			`CREATE TABLE ${mounted.schema}.${savedSeal} AS SELECT * FROM ${mounted.schema}.security_state WHERE user_id = $1`,
			[account.userId],
		);
		await anchored.user.disableRecovery({ userId: account.userId });
		await new Promise((resolve) => setTimeout(resolve, 20));

		await clearTheSwitch(account.userId);
		await restoreCodeRows(savedCodes);
		await mounted.connection.query(
			`DELETE FROM ${mounted.schema}.security_state WHERE user_id = $1`,
			[account.userId],
		);
		await mounted.connection.query(
			`INSERT INTO ${mounted.schema}.security_state SELECT * FROM ${mounted.schema}.${savedSeal}`,
			[],
		);
		const refused = await anchored.password
			.redeemResetWithRecoveryCode({
				email: account.email,
				recoveryCode: codes[2] ?? "",
				newPassword: REPLACEMENT,
				origin: "https://app.example.com",
			})
			.then(
				() => "accepted",
				(error: { code?: string }) => error.code ?? "thrown",
			);

		expect(refused).toBe("invalid_recovery_code");
		expect(
			alarms.filter((alarm) => alarm.userId === account.userId).map((alarm) => alarm.reason),
		).toContain("version_below_anchor");
	});
});
