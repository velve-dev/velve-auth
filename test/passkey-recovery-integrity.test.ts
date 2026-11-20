import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { postTo } from "./flows-fixtures.js";
import {
	alarmsRaisedFor,
	countOf,
	errorCodeOf,
	generateCodes,
	getFrom,
	mailedRecoveryLink,
	newAuthenticator,
	openRecoveryBench,
	type RecoveryBench,
	recoverTo,
	requestRecovery,
	signInWithPasskey,
	signInWithPassword,
	signUp,
	startRecovery,
	waitSeconds,
	withSession,
} from "./passkey-recovery-fixtures.js";

/**
 * T-INTEG-12: a held back passkey, its activation time and its cancellation are sealed state, so a
 * writer without the root key can neither shorten the wait, plant a recovery nor bring a
 * cancelled one back; the no-recovery switch cancels a waiting recovery and refuses a new one;
 * a reseal names what it ratified; and a recovery link resolves like every other link.
 */

let bench: RecoveryBench;

beforeAll(async () => {
	bench = await openRecoveryBench("pkrecovery_integrity");
}, 60_000);

afterAll(async () => {
	await bench.close();
});

beforeEach(() => {
	bench.sent.length = 0;
	bench.alarms.length = 0;
	bench.waitingPeriod = 3600;
});

function table(name: string): string {
	return `${bench.migrated.schema}.${name}`;
}

describe("a writer without the root key cannot move a recovery (S-INTEG-12)", () => {
	it("refuses a recovery whose waiting period a writer shortened, and raises the alarm", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		const authenticator = await newAuthenticator();
		expect((await recoverTo(bench, account, code ?? "", authenticator)).status).toBe(200);

		await bench.migrated.connection.query(
			`UPDATE ${table("passkey_recovery")} SET activates_at = now() - interval '1 second' WHERE user_id = $1`,
			[account.userId],
		);
		const signIn = await signInWithPasskey(bench, authenticator);

		expect([signIn.status, await errorCodeOf(signIn)]).toStrictEqual([
			401,
			"webauthn_credential_rejected",
		]);
		expect(await countOf(bench, "password_credential", account.userId)).toBe(1);
		expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(1);
		expect((await alarmsRaisedFor(bench, account.userId)).map((alarm) => alarm.reason)).toContain(
			"seal_mismatch",
		);
	});

	it("refuses a recovery a writer planted for an account that never asked for one", async () => {
		const victim = await signUp(bench);
		const attacker = await signUp(bench);
		const [code] = await generateCodes(bench, attacker);
		const authenticator = await newAuthenticator();
		bench.waitingPeriod = 1;
		expect((await recoverTo(bench, attacker, code ?? "", authenticator)).status).toBe(200);

		await bench.migrated.connection.query(
			`UPDATE ${table("passkey_recovery")} SET user_id = $2 WHERE user_id = $1`,
			[attacker.userId, victim.userId],
		);
		await waitSeconds(1.2);
		const signIn = await signInWithPasskey(bench, authenticator);

		expect(signIn.status).toBe(401);
		expect(await countOf(bench, "password_credential", victim.userId)).toBe(1);
		expect((await signInWithPassword(bench, victim.email)).status).toBe(401);
		expect((await alarmsRaisedFor(bench, victim.userId)).length).toBeGreaterThan(0);
	}, 30_000);

	it("refuses an account whose cancelled recovery a writer put back", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		const authenticator = await newAuthenticator();
		expect((await recoverTo(bench, account, code ?? "", authenticator)).status).toBe(200);
		const [saved] = await bench.migrated.connection.query<Record<string, unknown>>(
			`SELECT * FROM ${table("passkey_recovery")} WHERE user_id = $1`,
			[account.userId],
		);
		const cancelled = await bench.handler(
			postTo("/passkey-recovery/cancel", {}, withSession(account.sessionToken)),
		);
		expect(cancelled.status).toBe(204);

		const columns = Object.keys(saved ?? {});
		await bench.migrated.connection.query(
			`INSERT INTO ${table("passkey_recovery")} (${columns.join(", ")})
			VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
			columns.map((column) => saved?.[column]),
		);
		const read = await bench.handler(
			getFrom("/passkey-recovery", withSession(account.sessionToken)),
		);

		expect([read.status, await errorCodeOf(read)]).toStrictEqual([401, "session_required"]);
		expect((await alarmsRaisedFor(bench, account.userId)).map((alarm) => alarm.reason)).toContain(
			"seal_mismatch",
		);
	});

	it("keeps the new passkey out of every sign-in until the recovery is activated", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		const authenticator = await newAuthenticator();
		expect((await recoverTo(bench, account, code ?? "", authenticator)).status).toBe(200);

		const signIn = await signInWithPasskey(bench, authenticator);

		expect(signIn.status).toBe(401);
		expect(await countOf(bench, "webauthn_credential", account.userId)).toBe(0);
		expect(bench.alarms.filter((alarm) => alarm.userId === account.userId)).toStrictEqual([]);
	});
});

describe("the no-recovery switch and a recovery (S-INTEG-12, S-ENUM-10)", () => {
	it("cancels a waiting recovery when it goes on, so the new passkey never signs in", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		const authenticator = await newAuthenticator();
		bench.waitingPeriod = 1;
		expect((await recoverTo(bench, account, code ?? "", authenticator)).status).toBe(200);

		await bench.auth.user.disableRecovery({ userId: account.userId });
		await waitSeconds(1.2);

		expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(0);
		expect((await signInWithPasskey(bench, authenticator)).status).toBe(401);
		const read = await bench.handler(
			getFrom("/passkey-recovery", withSession(account.sessionToken)),
		);
		expect([read.status, await read.json()]).toStrictEqual([200, null]);
		expect((await signInWithPassword(bench, account.email)).status).toBe(200);
	}, 30_000);

	it("refuses a link mailed before the switch went on, and the link stays refused once it is off again", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		const token = await mailedRecoveryLink(bench, account.email);

		await bench.auth.user.disableRecovery({ userId: account.userId });
		await bench.auth.user.enableRecovery({ userId: account.userId });
		const answer = await startRecovery(bench, token, code ?? "");

		expect(await errorCodeOf(answer)).toBe("passkey_recovery_failed");
	});
});

describe("a recovery link is resolved like every other link (S-TOKEN-7)", () => {
	it("names the account and the purpose, and resolves to nothing once the switch is on", async () => {
		const account = await signUp(bench);
		const token = await mailedRecoveryLink(bench, account.email);

		const resolved = await bench.auth.oneTimeToken.resolve({ token });
		await bench.auth.user.disableRecovery({ userId: account.userId });
		const switchedOff = await bench.auth.oneTimeToken.resolve({ token });

		expect(resolved).toStrictEqual({ userId: account.userId, purpose: "passkey_recovery" });
		expect(switchedOff).toBeNull();
		expect((await requestRecovery(bench, account.email)).status).toBe(204);
		expect(bench.sent.at(-1)?.kind).toBe("request_for_unknown_address");
	});
});

describe("a reseal names the recovery it ratified (S-INTEG-7)", () => {
	it("reports the held back passkey and when it activates", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		const finished = await recoverTo(bench, account, code ?? "", await newAuthenticator());
		const { activatesAt } = (await finished.json()) as { activatesAt: string };

		const resealed = await bench.auth.maintenance.resealSecurityState({
			userId: account.userId,
			reason: "test",
		});

		expect(resealed.passkeyRecovery?.activatesAt).toStrictEqual(new Date(activatesAt));
		expect(typeof resealed.passkeyRecovery?.credentialId).toBe("string");
	});
});
