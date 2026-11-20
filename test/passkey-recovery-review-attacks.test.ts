import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { postTo } from "./flows-fixtures.js";
import {
	alarmsRaisedFor,
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
	startRecovery,
	waitSeconds,
	withSession,
} from "./passkey-recovery-fixtures.js";

/**
 * Review of change 6 against the requirement, not against the writer's tests: the attacker who
 * holds only the mailbox, only a stolen code, or a challenge of another ceremony, origin or
 * account; the held passkey presented as a second factor; a disabled account and the switch
 * between start and finish; the writer of the database who moves a recovery to another account
 * or edits what the seal covers; and the oracle of the fifth one-time token purpose, which the
 * branch took out of test/token-resolution-review-oracle.test.ts.
 */

let bench: RecoveryBench;

beforeAll(async () => {
	bench = await openRecoveryBench("pkrecovery_review_attacks");
}, 60_000);

afterAll(async () => {
	await bench.close();
});

beforeEach(() => {
	bench.sent.length = 0;
	bench.started.length = 0;
	bench.revoked.length = 0;
	bench.waitingPeriod = 60;
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

function withPending(token: string): Record<string, string> {
	return { Cookie: `${DEFAULT_COOKIE_NAMES.pending}=${token}` };
}

async function failedStep(answer: Response): Promise<readonly [number, string]> {
	return [answer.status, await errorCodeOf(answer)];
}

const FAILED_STEP = [400, "passkey_recovery_failed"] as const;

describe("an attacker who holds the mailbox but no recovery code", () => {
	it("gets no challenge with a guessed code or a code of another account, and the link and codes survive", async () => {
		const victim = await signUp(bench);
		const other = await signUp(bench);
		await generateCodes(bench, victim);
		const [othersCode] = await generateCodes(bench, other);
		const token = await mailedRecoveryLink(bench, victim.email);

		const guessed = await startRecovery(bench, token, "aaaa-bbbb-cccc-dddd");
		const foreign = await startRecovery(bench, token, othersCode ?? "");

		expect(await failedStep(guessed)).toStrictEqual(FAILED_STEP);
		expect(await failedStep(foreign)).toStrictEqual(FAILED_STEP);
		expect(await countOf(bench, "recovery_code", victim.userId)).toBe(10);
		expect(await countOf(bench, "recovery_code", other.userId)).toBe(10);
		expect(await countOf(bench, "webauthn_challenge", victim.userId)).toBe(0);
	});
});

describe("an attacker who holds a stolen recovery code but not the mailbox", () => {
	it("cannot pair it with a link mailed to his own account or a link of another purpose", async () => {
		const victim = await signUp(bench);
		const attacker = await signUp(bench);
		const [stolen] = await generateCodes(bench, victim);
		await generateCodes(bench, attacker);
		const ownLink = await mailedRecoveryLink(bench, attacker.email);
		await bench.handler(postTo("/sign-in/magic-link/request", { email: victim.email }));
		const magic = bench.sent.find(
			(message) => message.kind === "magic_link" && message.to === victim.email,
		);

		const withOwnLink = await startRecovery(bench, ownLink, stolen ?? "");
		const withMagicLink = await startRecovery(
			bench,
			magic?.kind === "magic_link" ? magic.token : "missing",
			stolen ?? "",
		);

		expect(await failedStep(withOwnLink)).toStrictEqual(FAILED_STEP);
		expect(await failedStep(withMagicLink)).toStrictEqual(FAILED_STEP);
		expect(await countOf(bench, "recovery_code", victim.userId)).toBe(10);
	});
});

describe("a registration with a challenge, an origin or a response that is not this recovery's", () => {
	it("refuses a challenge of the passkey sign-in, which names no account", async () => {
		const account = await signUp(bench);
		const started = await bench.handler(postTo("/sign-in/passkey/start", {}));
		const { challengeToken } = (await started.json()) as { challengeToken: string };
		const response = await (await newAuthenticator()).attest({ challenge: challengeToken });

		const finished = await finishRecovery(bench, challengeToken, response);

		expect(await failedStep(finished)).toStrictEqual(FAILED_STEP);
		expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(0);
	});

	it("refuses a recovery's challenge at the registration of a session, so no passkey skips the waiting period", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		const token = await mailedRecoveryLink(bench, account.email);
		const started = await startedRecovery(bench, token, code ?? "");
		const response = await (await newAuthenticator()).attest({
			challenge: started.challengeToken,
		});

		const registered = await bench.handler(
			postTo(
				"/factor/webauthn/register/finish",
				{ challengeToken: started.challengeToken, response, label: "smuggled" },
				withSession(account.sessionToken),
			),
		);

		expect(registered.status).not.toBe(200);
		expect(await countOf(bench, "webauthn_credential", account.userId)).toBe(0);
	});

	it("refuses an attestation made for another origin", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		const token = await mailedRecoveryLink(bench, account.email);
		const started = await startedRecovery(bench, token, code ?? "");
		const response = await (await newAuthenticator()).attest({
			challenge: started.challengeToken,
			origin: "https://evil.example.com",
		});

		const finished = await finishRecovery(bench, started.challengeToken, response);

		expect(await failedStep(finished)).toStrictEqual(FAILED_STEP);
		expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(0);
	});

	it("refuses a replayed registration response, leaving one recovery and one notice", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		const token = await mailedRecoveryLink(bench, account.email);
		const started = await startedRecovery(bench, token, code ?? "");
		const response = await (await newAuthenticator()).attest({
			challenge: started.challengeToken,
		});

		const first = await finishRecovery(bench, started.challengeToken, response);
		const replayed = await finishRecovery(bench, started.challengeToken, response);

		expect(first.status).toBe(200);
		expect(await failedStep(replayed)).toStrictEqual(FAILED_STEP);
		expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(1);
		expect(bench.sent.filter((sent) => sent.kind === "passkey_recovery_started")).toHaveLength(1);
		expect(bench.started).toHaveLength(1);
	});
});

describe("the held passkey as a second factor (S-INTEG-12)", () => {
	it("completes no pending sign-in during the waiting period nor after it, and activates nothing", async () => {
		const account = await signUp(bench);
		await registerPasskey(bench, account);
		const [code] = await generateCodes(bench, account);
		bench.waitingPeriod = 1;
		const held = await newAuthenticator();
		expect((await recoverTo(bench, account, code ?? "", held)).status).toBe(200);

		const secondFactorWith = async (): Promise<Response> => {
			const signedIn = await signInWithPassword(bench, account.email);
			const pending = cookieIn(signedIn, DEFAULT_COOKIE_NAMES.pending);
			const started = await bench.handler(
				postTo("/factor/webauthn/authenticate/start", {}, withPending(pending ?? "")),
			);
			const { challengeToken } = (await started.json()) as { challengeToken: string };
			const response = await held.assert({ challenge: challengeToken });
			return bench.handler(
				postTo(
					"/factor/webauthn/authenticate/finish",
					{ challengeToken, response },
					withPending(pending ?? ""),
				),
			);
		};

		const during = await secondFactorWith();
		await waitSeconds(1.2);
		const after = await secondFactorWith();

		expect(during.status).not.toBe(200);
		expect(after.status).not.toBe(200);
		expect(cookieIn(after, DEFAULT_COOKIE_NAMES.session)).toBeNull();
		expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(1);
		expect(await countOf(bench, "password_credential", account.userId)).toBe(1);
	}, 30_000);
});

describe("an account that becomes unrecoverable between start and finish", () => {
	it("refuses the finish of a disabled account and holds nothing", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		const token = await mailedRecoveryLink(bench, account.email);
		const started = await startedRecovery(bench, token, code ?? "");
		const response = await (await newAuthenticator()).attest({
			challenge: started.challengeToken,
		});
		await bench.auth.user.disable({ userId: account.userId, reason: "review" });

		const finished = await finishRecovery(bench, started.challengeToken, response);

		expect(await failedStep(finished)).toStrictEqual(FAILED_STEP);
		expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(0);
		expect(bench.started).toHaveLength(0);
	});

	it("refuses the finish once the no-recovery switch went on and holds nothing", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		const token = await mailedRecoveryLink(bench, account.email);
		const started = await startedRecovery(bench, token, code ?? "");
		const response = await (await newAuthenticator()).attest({
			challenge: started.challengeToken,
		});
		await bench.auth.user.disableRecovery({ userId: account.userId });

		const finished = await finishRecovery(bench, started.challengeToken, response);

		expect(await failedStep(finished)).toStrictEqual(FAILED_STEP);
		expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(0);
	});

	it("never activates the recovery of an account disabled during its waiting period", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		bench.waitingPeriod = 1;
		const held = await newAuthenticator();
		expect((await recoverTo(bench, account, code ?? "", held)).status).toBe(200);
		await bench.auth.user.disable({ userId: account.userId, reason: "review" });
		await waitSeconds(1.2);

		const signedIn = await signInWithPasskey(bench, held);

		expect(signedIn.status).toBe(401);
		expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(1);
		expect(await countOf(bench, "password_credential", account.userId)).toBe(1);
		expect(bench.sent.some((sent) => sent.kind === "passkey_recovery_completed")).toBe(false);
	}, 30_000);
});

describe("a writer of the database without the root key (S-INTEG-12)", () => {
	it("cannot hand a held passkey to another account", async () => {
		const attacker = await signUp(bench);
		const victim = await signUp(bench);
		const [code] = await generateCodes(bench, attacker);
		bench.waitingPeriod = 1;
		const held = await newAuthenticator();
		expect((await recoverTo(bench, attacker, code ?? "", held)).status).toBe(200);
		await bench.migrated.connection.query(
			`UPDATE ${bench.migrated.schema}.passkey_recovery SET user_id = $2 WHERE user_id = $1`,
			[attacker.userId, victim.userId],
		);
		await waitSeconds(1.2);

		const signedIn = await signInWithPasskey(bench, held);

		expect(signedIn.status).toBe(401);
		expect(await countOf(bench, "webauthn_credential", victim.userId)).toBe(0);
		expect(await countOf(bench, "password_credential", victim.userId)).toBe(1);
		expect(await alarmsRaisedFor(bench, victim.userId)).not.toHaveLength(0);
	}, 30_000);

	it("cannot activate a recovery by moving its time to minus infinity", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		bench.waitingPeriod = 3600;
		const held = await newAuthenticator();
		expect((await recoverTo(bench, account, code ?? "", held)).status).toBe(200);
		await bench.migrated.connection.query(
			`UPDATE ${bench.migrated.schema}.passkey_recovery SET activates_at = '-infinity' WHERE user_id = $1`,
			[account.userId],
		);

		const signedIn = await signInWithPasskey(bench, held);
		const byPassword = await signInWithPassword(bench, account.email);

		expect(await countOf(bench, "webauthn_credential", account.userId)).toBe(0);
		expect(await countOf(bench, "password_credential", account.userId)).toBe(1);
		//a shortened waiting period is a broken state, answered as an unknown passkey and alarmed (3.18)
		expect
			.soft([signedIn.status, await errorCodeOf(signedIn)])
			.toStrictEqual([401, "webauthn_credential_rejected"]);
		expect.soft(byPassword.status).not.toBe(500);
		expect(await alarmsRaisedFor(bench, account.userId)).not.toHaveLength(0);
	});

	it("cannot swap the held public key for one of its own", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		bench.waitingPeriod = 1;
		const held = await newAuthenticator();
		expect((await recoverTo(bench, account, code ?? "", held)).status).toBe(200);
		await bench.migrated.connection.query(
			`UPDATE ${bench.migrated.schema}.passkey_recovery
			 SET public_key = public_key || '\\x00'::bytea WHERE user_id = $1`,
			[account.userId],
		);
		await waitSeconds(1.2);

		const signedIn = await signInWithPasskey(bench, held);

		expect(signedIn.status).toBe(401);
		expect(await countOf(bench, "webauthn_credential", account.userId)).toBe(0);
		expect(await countOf(bench, "password_credential", account.userId)).toBe(1);
	}, 30_000);
});

describe("the recovery link through the oracle the branch narrowed (S-TOKEN-7, T-TOKEN-7)", () => {
	const tampers: readonly (readonly [
		string,
		(account: { readonly userId: string }) => Promise<void>,
	])[] = [
		[
			"disabled",
			(account) => bench.auth.user.disable({ userId: account.userId, reason: "review" }),
		],
		[
			"seal broken by a writer",
			async (account) => {
				await bench.migrated.connection.query(
					`UPDATE ${bench.migrated.schema}.user SET email_verified_at = now() - interval '1 day' WHERE id = $1`,
					[account.userId],
				);
			},
		],
		[
			"expired",
			async (account) => {
				await bench.migrated.connection.query(
					`UPDATE ${bench.migrated.schema}.one_time_token SET expires_at = now() - interval '1 second'
					 WHERE user_id = $1`,
					[account.userId],
				);
			},
		],
	];

	for (const [state, tamper] of tampers) {
		it(`${state}: resolve answers null exactly where the start refuses`, async () => {
			const account = await signUp(bench);
			const [code] = await generateCodes(bench, account);
			const token = await mailedRecoveryLink(bench, account.email);
			await tamper(account);

			const answer = await bench.auth.oneTimeToken.resolve({ token });
			const started = await startRecovery(bench, token, code ?? "");

			expect(answer).toBeNull();
			expect(await failedStep(started)).toStrictEqual(FAILED_STEP);
		});
	}

	it("untouched: resolve names the account and the start then succeeds", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		const token = await mailedRecoveryLink(bench, account.email);

		const answer = await bench.auth.oneTimeToken.resolve({ token });
		const started = await startRecovery(bench, token, code ?? "");

		expect(answer).toStrictEqual({ userId: account.userId, purpose: "passkey_recovery" });
		expect(started.status).toBe(200);
		expect(await bench.auth.oneTimeToken.resolve({ token })).toBeNull();
	});
});
