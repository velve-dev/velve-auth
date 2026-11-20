import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { postTo } from "./flows-fixtures.js";
import {
	countOf,
	errorCodeOf,
	finishRecovery,
	generateCodes,
	getFrom,
	mailedRecoveryLink,
	newAuthenticator,
	openRecoveryBench,
	type RecoveryBench,
	recoverTo,
	registerPasskey,
	sessionResolves,
	signInWithPasskey,
	signInWithPassword,
	signUp,
	startedRecovery,
	waitSeconds,
	withSession,
} from "./passkey-recovery-fixtures.js";

/**
 * T-INTEG-12 and T-LINK-9: the address, the mailed link with one recovery code and the
 * registration of a new passkey; the waiting period during which the new passkey signs nobody in
 * and every session of the account sees and can cancel it; the activation that leaves the new
 * passkey as the account's one way in, every session ended and the address told.
 */

let bench: RecoveryBench;

beforeAll(async () => {
	bench = await openRecoveryBench("pkrecovery_flow");
}, 60_000);

afterAll(async () => {
	await bench.close();
});

beforeEach(() => {
	bench.sent.length = 0;
	bench.started.length = 0;
	bench.revoked.length = 0;
	bench.waitingPeriodsAskedFor.length = 0;
});

describe("a recovery with a waiting period (S-INTEG-12, S-LINK-9)", () => {
	it("holds the new passkey back, tells the address and the plugin, and activates at its first sign-in", async () => {
		const account = await signUp(bench);
		const oldPasskey = await registerPasskey(bench, account);
		const codes = await generateCodes(bench, account);
		bench.waitingPeriod = 2;
		bench.sent.length = 0;
		const token = await mailedRecoveryLink(bench, account.email);
		const started = await startedRecovery(bench, token, codes[0] ?? "");
		const authenticator = await newAuthenticator();
		const response = await authenticator.attest({ challenge: started.challengeToken });

		const finished = await finishRecovery(bench, started.challengeToken, response);
		const body = (await finished.json()) as { status: string; activatesAt: string };

		expect(finished.status).toBe(200);
		expect(body.status).toBe("pending");
		expect(new Date(body.activatesAt).getTime()).toBeGreaterThan(Date.now());
		expect(bench.waitingPeriodsAskedFor).toStrictEqual([{ userId: account.userId }]);
		// the registration of the recovery asks for user verification whatever the setting says
		expect(started.publicKeyOptions.authenticatorSelection?.userVerification).toBe("required");
		expect(started.publicKeyOptions.excludeCredentials?.map((each) => each.id)).toStrictEqual([
			oldPasskey.credentialId,
		]);
		expect(bench.sent.map((message) => message.kind)).toStrictEqual([
			"passkey_recovery",
			"passkey_recovery_started",
		]);
		expect(bench.sent[1]).toStrictEqual({
			kind: "passkey_recovery_started",
			to: account.email,
			userId: account.userId,
			activatesAt: new Date(body.activatesAt),
		});
		expect(bench.started).toStrictEqual([{ userId: account.userId }]);

		// during the waiting period the new passkey signs nobody in and the old ways in still work
		const early = await signInWithPasskey(bench, authenticator);
		expect([early.status, await errorCodeOf(early)]).toStrictEqual([
			401,
			"webauthn_credential_rejected",
		]);
		expect((await signInWithPassword(bench, account.email)).status).toBe(200);
		expect((await signInWithPasskey(bench, oldPasskey)).status).toBe(200);
		expect(await sessionResolves(bench, account.sessionToken)).toBe(true);
		const seen = await bench.handler(
			getFrom("/passkey-recovery", withSession(account.sessionToken)),
		);
		expect(seen.status).toBe(200);
		expect(new Date(((await seen.json()) as { activatesAt: string }).activatesAt)).toStrictEqual(
			new Date(body.activatesAt),
		);

		await waitSeconds(2.2);
		bench.sent.length = 0;
		const sessionsBefore = await countOf(bench, "session", account.userId);
		const signedIn = await signInWithPasskey(bench, authenticator);
		const signedInBody = (await signedIn.json()) as {
			status: string;
			session: { factors: string[] };
		};

		expect(signedIn.status).toBe(200);
		expect(signedInBody.status).toBe("signed_in");
		expect(signedInBody.session.factors).toStrictEqual(["webauthn"]);
		expect(bench.sent).toStrictEqual([
			{ kind: "passkey_recovery_completed", to: account.email, userId: account.userId },
		]);
		// every other way in is gone and only the new passkey is left
		expect((await signInWithPassword(bench, account.email)).status).toBe(401);
		expect((await signInWithPasskey(bench, oldPasskey)).status).toBe(401);
		expect(await sessionResolves(bench, account.sessionToken)).toBe(false);
		expect(await countOf(bench, "recovery_code", account.userId)).toBe(0);
		expect(await countOf(bench, "password_credential", account.userId)).toBe(0);
		expect(await countOf(bench, "webauthn_credential", account.userId)).toBe(1);
		expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(0);
		expect(sessionsBefore).toBe(2);
		expect(bench.revoked.length).toBe(sessionsBefore);
		expect(new Set(bench.revoked.map((event) => event.reason))).toStrictEqual(
			new Set(["passkey_recovery"]),
		);
		// L-13: the new passkey is the last way in and cannot be removed
		const session = cookieOf(signedIn);
		const list = await bench.handler(getFrom("/factor/webauthn/list", withSession(session)));
		const [credential] = (await list.json()) as { id: string; label: string }[];
		expect(credential?.label).toBe("recovered key");
		const removal = await bench.handler(
			postTo("/factor/webauthn/remove", { credentialId: credential?.id }, withSession(session)),
		);
		expect(await errorCodeOf(removal)).toBe("last_sign_in_method");
	}, 30_000);

	it("reports a recovery past its waiting period without activating it, and a cancel then activates it", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		bench.waitingPeriod = 1;
		const authenticator = await newAuthenticator();
		expect((await recoverTo(bench, account, code ?? "", authenticator)).status).toBe(200);
		await waitSeconds(1.2);

		const read = await bench.handler(
			getFrom("/passkey-recovery", withSession(account.sessionToken)),
		);
		const { activatesAt } = (await read.json()) as { activatesAt: string };

		expect(read.status).toBe(200);
		expect(new Date(activatesAt).getTime()).toBeLessThanOrEqual(Date.now());
		// a reading route changes no row (S-CSRF-4), so the account is as it was
		expect(await countOf(bench, "password_credential", account.userId)).toBe(1);
		expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(1);

		const cancelled = await bench.handler(
			postTo("/passkey-recovery/cancel", {}, withSession(account.sessionToken)),
		);

		expect([cancelled.status, await errorCodeOf(cancelled)]).toStrictEqual([
			401,
			"session_required",
		]);
		expect(bench.sent.at(-1)?.kind).toBe("passkey_recovery_completed");
		expect(await countOf(bench, "password_credential", account.userId)).toBe(0);
		expect((await signInWithPasskey(bench, authenticator)).status).toBe(200);
	}, 30_000);

	it("lets a fresh session cancel the recovery, which voids the new passkey and gives nothing back", async () => {
		const account = await signUp(bench);
		const codes = await generateCodes(bench, account);
		bench.waitingPeriod = 1;
		const authenticator = await newAuthenticator();
		expect((await recoverTo(bench, account, codes[0] ?? "", authenticator)).status).toBe(200);

		const cancelled = await bench.handler(
			postTo("/passkey-recovery/cancel", {}, withSession(account.sessionToken)),
		);
		const read = await bench.handler(
			getFrom("/passkey-recovery", withSession(account.sessionToken)),
		);

		expect(cancelled.status).toBe(204);
		expect([read.status, await read.json()]).toStrictEqual([200, null]);
		await waitSeconds(1.2);
		expect((await signInWithPasskey(bench, authenticator)).status).toBe(401);
		expect((await signInWithPassword(bench, account.email)).status).toBe(200);
		expect(await sessionResolves(bench, account.sessionToken)).toBe(true);
		// the code the recovery spent stays spent
		expect(await countOf(bench, "recovery_code", account.userId)).toBe(codes.length - 1);
		expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(0);
		expect(await countOf(bench, "webauthn_credential", account.userId)).toBe(0);
	}, 30_000);

	it("lets a session that is no longer fresh cancel too, as the owner may not be able to sign in again", async () => {
		const stale = await openRecoveryBench("pkrecovery_stale", {
			session: { freshnessWindow: "1s" },
		});
		try {
			const account = await signUp(stale);
			const [code] = await generateCodes(stale, account);
			stale.waitingPeriod = 60;
			expect((await recoverTo(stale, account, code ?? "", await newAuthenticator())).status).toBe(
				200,
			);
			await waitSeconds(1.2);

			const answer = await stale.handler(
				postTo("/passkey-recovery/cancel", {}, withSession(account.sessionToken)),
			);

			expect(answer.status).toBe(204);
			expect(await countOf(stale, "passkey_recovery", account.userId)).toBe(0);
		} finally {
			await stale.close();
		}
	}, 30_000);

	it("voids a challenge a second start issued, so no registration finishes after a cancel", async () => {
		const account = await signUp(bench);
		const codes = await generateCodes(bench, account);
		bench.waitingPeriod = 3600;
		const first = await startedRecovery(
			bench,
			await mailedRecoveryLink(bench, account.email),
			codes[0] ?? "",
		);
		const second = await startedRecovery(
			bench,
			await mailedRecoveryLink(bench, account.email),
			codes[1] ?? "",
		);
		const firstKey = await newAuthenticator();
		const secondKey = await newAuthenticator();
		const held = await finishRecovery(
			bench,
			first.challengeToken,
			await firstKey.attest({ challenge: first.challengeToken }),
		);
		expect(held.status).toBe(200);

		const cancelled = await bench.handler(
			postTo("/passkey-recovery/cancel", {}, withSession(account.sessionToken)),
		);
		const late = await finishRecovery(
			bench,
			second.challengeToken,
			await secondKey.attest({ challenge: second.challengeToken }),
		);

		expect(cancelled.status).toBe(204);
		expect([late.status, await errorCodeOf(late)]).toStrictEqual([400, "passkey_recovery_failed"]);
		expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(0);
	}, 30_000);
});

describe("a recovery without a waiting period (S-INTEG-12)", () => {
	it("replaces every way in at once and tells the address it is done, with no notice of a pending one", async () => {
		const account = await signUp(bench);
		await registerPasskey(bench, account);
		const [code] = await generateCodes(bench, account);
		bench.waitingPeriod = 0;
		const authenticator = await newAuthenticator();
		bench.sent.length = 0;

		const finished = await recoverTo(bench, account, code ?? "", authenticator);

		expect([finished.status, await finished.json()]).toStrictEqual([200, { status: "completed" }]);
		expect(bench.sent.map((message) => message.kind)).toStrictEqual([
			"passkey_recovery",
			"passkey_recovery_completed",
		]);
		expect(bench.started).toStrictEqual([]);
		expect(await sessionResolves(bench, account.sessionToken)).toBe(false);
		expect((await signInWithPassword(bench, account.email)).status).toBe(401);
		expect((await signInWithPasskey(bench, authenticator)).status).toBe(200);
		expect(await countOf(bench, "webauthn_credential", account.userId)).toBe(1);
		expect(await countOf(bench, "recovery_code", account.userId)).toBe(0);
	});

	it("clamps a waiting period below zero to none and asks the function on every registration", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		bench.waitingPeriod = -30;

		const finished = await recoverTo(bench, account, code ?? "", await newAuthenticator());

		expect(await finished.json()).toStrictEqual({ status: "completed" });
		expect(bench.waitingPeriodsAskedFor).toStrictEqual([{ userId: account.userId }]);
	});
});

function cookieOf(answer: Response): string {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		if (pair.startsWith(`${DEFAULT_COOKIE_NAMES.session}=`)) {
			return pair.slice(DEFAULT_COOKIE_NAMES.session.length + 1);
		}
	}
	return "";
}
