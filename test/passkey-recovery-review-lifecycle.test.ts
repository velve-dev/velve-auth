import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { VelveAuthConfig } from "../src/core/auth/config.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import type { SessionRevokeEvent } from "../src/index.js";
import { TEST_ORIGIN } from "./auth-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import {
	countOf,
	errorCodeOf,
	finishRecovery,
	generateCodes,
	mailedRecoveryLink,
	newAuthenticator,
	openRecoveryBench,
	type RecoveryBench,
	recoverTo,
	registerPasskey,
	signInWithPasskey,
	signInWithPassword,
	signUp,
	startedRecovery,
	waitSeconds,
	withSession,
} from "./passkey-recovery-fixtures.js";

/**
 * Review of change 6: what an activated recovery leaves behind (links, pending sign-ins, the
 * TOTP secret), what two activations, two cancels and a cancel racing an activation do, what a
 * plugin that refuses or throws can do to a recovery, and what the waiting period function costs
 * when it throws.
 */

const RELYING_PARTY_ID = "app.example.com";

function webauthnWith(
	waitingPeriodInSeconds: (context: { userId: string }) => number,
): NonNullable<VelveAuthConfig<"email">["webauthn"]> {
	return {
		relyingPartyId: RELYING_PARTY_ID,
		relyingPartyName: "Velve Auth tests",
		origins: [TEST_ORIGIN],
		userVerification: "required",
		recovery: { waitingPeriodInSeconds },
	};
}

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

function withPending(token: string): Record<string, string> {
	return { Cookie: `${DEFAULT_COOKIE_NAMES.pending}=${token}` };
}

describe("an activated recovery leaves no way in behind it (S-INTEG-12, L-13)", () => {
	let bench: RecoveryBench;

	beforeAll(async () => {
		bench = await openRecoveryBench("pkrecovery_review_leftovers");
	}, 60_000);

	afterAll(async () => {
		await bench.close();
	});

	it("retires every mailed link and every pending sign-in, and removes the TOTP secret", async () => {
		const account = await signUp(bench);
		await registerPasskey(bench, account);
		const [code] = await generateCodes(bench, account);
		const enrolment = await bench.handler(
			postTo("/factor/totp/enroll/start", {}, withSession(account.sessionToken)),
		);
		expect(enrolment.status).toBe(200);
		bench.waitingPeriod = 1;
		const held = await newAuthenticator();
		expect((await recoverTo(bench, account, code ?? "", held)).status).toBe(200);

		await bench.handler(postTo("/password/request-reset", { email: account.email }));
		await bench.handler(
			postTo(
				"/email/request-change",
				{ newEmail: `moved-${Date.now()}@example.com` },
				withSession(account.sessionToken),
			),
		);
		const resetLink = bench.sent.findLast((sent) => sent.kind === "password_reset");
		const changeLink = bench.sent.findLast((sent) => sent.kind === "email_change");
		const pendingSignIn = cookieIn(
			await signInWithPassword(bench, account.email),
			DEFAULT_COOKIE_NAMES.pending,
		);
		expect(resetLink?.kind).toBe("password_reset");
		expect(changeLink?.kind).toBe("email_change");
		expect(pendingSignIn).not.toBeNull();
		expect(await countOf(bench, "totp_credential", account.userId)).toBe(1);

		await waitSeconds(1.2);
		expect((await signInWithPasskey(bench, held)).status).toBe(200);

		const reset = await bench.handler(
			postTo("/password/redeem-reset", {
				token: resetLink?.kind === "password_reset" ? resetLink.token : "",
				newPassword: "another-horse-battery-staple",
			}),
		);
		const changed = await bench.handler(
			postTo("/email/redeem-change", {
				token: changeLink?.kind === "email_change" ? changeLink.token : "",
			}),
		);
		const secondFactor = await bench.handler(
			postTo("/factor/webauthn/authenticate/start", {}, withPending(pendingSignIn ?? "")),
		);

		expect([reset.status, await errorCodeOf(reset)]).toStrictEqual([400, "invalid_token"]);
		expect([changed.status, await errorCodeOf(changed)]).toStrictEqual([400, "invalid_token"]);
		expect(await errorCodeOf(secondFactor)).toBe("invalid_pending_authentication");
		expect(await countOf(bench, "totp_credential", account.userId)).toBe(0);
		expect(await countOf(bench, "password_credential", account.userId)).toBe(0);
		expect(await countOf(bench, "webauthn_credential", account.userId)).toBe(1);
		expect(await countOf(bench, "identity", account.userId)).toBe(0);
	}, 30_000);

	it("activates once when two sign-ins with the new passkey arrive together", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		bench.waitingPeriod = 1;
		const held = await newAuthenticator();
		expect((await recoverTo(bench, account, code ?? "", held)).status).toBe(200);
		await waitSeconds(1.2);
		bench.sent.length = 0;
		bench.revoked.length = 0;

		const answers = await Promise.all([
			signInWithPasskey(bench, held),
			signInWithPasskey(bench, held),
		]);

		expect(answers.some((answer) => answer.status === 200)).toBe(true);
		expect(bench.sent.filter((sent) => sent.kind === "passkey_recovery_completed")).toHaveLength(1);
		expect(bench.revoked).toHaveLength(1);
		expect(await countOf(bench, "webauthn_credential", account.userId)).toBe(1);
		expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(0);
	}, 30_000);

	it("answers two cancels at once alike and leaves the account untouched", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		bench.waitingPeriod = 3600;
		expect((await recoverTo(bench, account, code ?? "", await newAuthenticator())).status).toBe(
			200,
		);

		const answers = await Promise.all([
			bench.handler(postTo("/passkey-recovery/cancel", {}, withSession(account.sessionToken))),
			bench.handler(postTo("/passkey-recovery/cancel", {}, withSession(account.sessionToken))),
		]);

		expect(answers.map((answer) => answer.status)).toStrictEqual([204, 204]);
		expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(0);
		expect(await countOf(bench, "recovery_code", account.userId)).toBe(9);
		expect(await countOf(bench, "password_credential", account.userId)).toBe(1);
	});
});

describe("a cancel that loses the race to an activation (S-LINK-9, S-INTEG-12)", () => {
	let bench: RecoveryBench;
	let hookEntered: () => void = () => undefined;
	let releaseHook: () => void = () => undefined;
	let holdTheHook = false;

	beforeAll(async () => {
		bench = await openRecoveryBench("pkrecovery_review_race", {
			plugins: [
				{
					id: "gate",
					hooks: {
						beforeSessionRevoke: async (_event: SessionRevokeEvent) => {
							if (!holdTheHook) {
								return;
							}
							holdTheHook = false;
							hookEntered();
							await new Promise<void>((resolve) => {
								releaseHook = resolve;
							});
						},
					},
				},
			],
		});
	}, 60_000);

	afterAll(async () => {
		await bench.close();
	});

	it("does not tell the owner the recovery was cancelled when it was activated instead", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		bench.waitingPeriod = 1;
		const held = await newAuthenticator();
		expect((await recoverTo(bench, account, code ?? "", held)).status).toBe(200);
		await waitSeconds(1.2);

		const entered = new Promise<void>((resolve) => {
			hookEntered = resolve;
		});
		holdTheHook = true;
		const signingIn = signInWithPasskey(bench, held);
		await entered;
		const cancelling = bench.handler(
			postTo("/passkey-recovery/cancel", {}, withSession(account.sessionToken)),
		);
		await waitSeconds(0.5);
		releaseHook();
		const [signedIn, cancelled] = await Promise.all([signingIn, cancelling]);

		expect(signedIn.status).toBe(200);
		expect(await countOf(bench, "webauthn_credential", account.userId)).toBe(1);
		expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(0);
		//the recovery took effect and the cancelling session ended, so 204 would be a false all-clear
		expect([cancelled.status, await errorCodeOf(cancelled)]).toStrictEqual([
			401,
			"session_required",
		]);
	}, 30_000);
});

describe("a plugin that refuses or throws (3.11, E-758, E-3773)", () => {
	let bench: RecoveryBench;
	let refuseRevocations = false;
	let throwOnStart = false;

	beforeAll(async () => {
		bench = await openRecoveryBench("pkrecovery_review_plugin", {
			plugins: [
				{
					id: "hostile",
					hooks: {
						beforeSessionRevoke: async () => {
							if (refuseRevocations) {
								throw new Error("refused by the plugin");
							}
						},
						afterPasskeyRecoveryStart: async () => {
							if (throwOnStart) {
								throw new Error("thrown by the plugin");
							}
						},
					},
				},
			],
		});
	}, 60_000);

	afterAll(async () => {
		await bench.close();
	});

	beforeEach(() => {
		refuseRevocations = false;
		throwOnStart = false;
		bench.sent.length = 0;
	});

	it("keeps the account as it was when a revocation hook refuses the activation", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		bench.waitingPeriod = 1;
		const held = await newAuthenticator();
		expect((await recoverTo(bench, account, code ?? "", held)).status).toBe(200);
		await waitSeconds(1.2);
		refuseRevocations = true;

		const refused = await signInWithPasskey(bench, held);

		expect(refused.status).not.toBe(200);
		expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(1);
		expect(await countOf(bench, "password_credential", account.userId)).toBe(1);
		expect(await countOf(bench, "session", account.userId)).toBe(1);
		expect(bench.sent.some((sent) => sent.kind === "passkey_recovery_completed")).toBe(false);

		refuseRevocations = false;
		expect((await signInWithPasskey(bench, held)).status).toBe(200);
		expect(await countOf(bench, "password_credential", account.userId)).toBe(0);
	}, 30_000);

	it("still tells the address and keeps the recovery waiting when the start hook throws", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		bench.waitingPeriod = 3600;
		throwOnStart = true;

		const finished = await recoverTo(bench, account, code ?? "", await newAuthenticator());

		expect(finished.status).not.toBe(200);
		expect(bench.sent.filter((sent) => sent.kind === "passkey_recovery_started")).toHaveLength(1);
		expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(1);
		const seen = await bench.handler(
			new Request("https://api.example.com/passkey-recovery", {
				headers: { Origin: TEST_ORIGIN, ...withSession(account.sessionToken) },
			}),
		);
		expect(((await seen.json()) as { activatesAt?: string } | null)?.activatesAt).toBeTypeOf(
			"string",
		);
	});
});

describe("the waiting period function (E-3764)", () => {
	let bench: RecoveryBench;
	let answer: () => unknown = () => 0;

	beforeAll(async () => {
		bench = await openRecoveryBench("pkrecovery_review_waiting", {
			webauthn: webauthnWith(() => answer() as number),
		});
	}, 60_000);

	afterAll(async () => {
		await bench.close();
	});

	it("waits the longest for an answer that is a promise", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		answer = () => Promise.resolve(0);

		const finished = await recoverTo(bench, account, code ?? "", await newAuthenticator());
		const body = (await finished.json()) as { status: string; activatesAt: string };

		expect(body.status).toBe("pending");
		const waited = new Date(body.activatesAt).getTime() - Date.now();
		expect(waited).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
		expect(waited).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000);
	});

	it("completes at once for an answer of minus infinity, as below zero is documented", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		answer = () => Number.NEGATIVE_INFINITY;

		const finished = await recoverTo(bench, account, code ?? "", await newAuthenticator());

		expect(((await finished.json()) as { status: string }).status).toBe("completed");
	});

	it("writes nothing before a function that throws, so the same registration finishes once it answers", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		const token = await mailedRecoveryLink(bench, account.email);
		const started = await startedRecovery(bench, token, code ?? "");
		const response = await (await newAuthenticator()).attest({
			challenge: started.challengeToken,
		});
		answer = () => {
			throw new Error("the application's waiting period failed");
		};

		const failed = await finishRecovery(bench, started.challengeToken, response);
		answer = () => 3600;
		const retried = await finishRecovery(bench, started.challengeToken, response);

		expect([failed.status, await errorCodeOf(failed)]).toStrictEqual([500, "internal_error"]);
		//E-3764 and DOCUMENTATION.md say the failure comes before anything is written
		expect(retried.status).toBe(200);
	});
});
