import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { postTo } from "./flows-fixtures.js";
import {
	type Call,
	countOf,
	errorCodeOf,
	finishRecovery,
	generateCodes,
	lastRecoveryLinkTo,
	mailedRecoveryLink,
	newAuthenticator,
	openRecoveryBench,
	type RecoveryBench,
	recoverTo,
	requestRecovery,
	signUp,
	startedRecovery,
	startRecovery,
	withSession,
} from "./passkey-recovery-fixtures.js";

/**
 * T-ENUM-10 and T-RACE-7: the request for a recovery runs one path whatever the address names,
 * every failing step after it gives one answer whichever factor was wrong, and two attempts at
 * the same link, the same code or the same account leave exactly one winner.
 */

const UNKNOWN = "nobody-recovers-here@example.com";

let bench: RecoveryBench;

beforeAll(async () => {
	bench = await openRecoveryBench("pkrecovery_uniform");
}, 60_000);

afterAll(async () => {
	await bench.close();
});

beforeEach(() => {
	bench.sent.length = 0;
	bench.waitingPeriod = 3600;
});

interface Observation {
	readonly status: number;
	readonly body: string;
	readonly calls: readonly Call[];
	readonly sends: readonly string[];
}

async function observedRequest(email: string): Promise<Observation> {
	await bench.migrated.connection.query(`DELETE FROM ${bench.migrated.schema}.rate_bucket`, []);
	bench.calls.length = 0;
	bench.sent.length = 0;
	const answer = await requestRecovery(bench, email);
	return {
		status: answer.status,
		body: await answer.text(),
		calls: [...bench.calls],
		sends: bench.sent.map((message) => message.kind),
	};
}

describe("the request runs one path whatever the address names (S-ENUM-10)", () => {
	it("runs the same statements and sends once for an unknown address and a switched-off account", async () => {
		const account = await signUp(bench);
		await bench.auth.user.disableRecovery({ userId: account.userId });

		const switchedOff = await observedRequest(account.email);
		const unknown = await observedRequest(UNKNOWN);

		expect(switchedOff.calls.length).toBeGreaterThan(3);
		expect(switchedOff.calls).toStrictEqual(unknown.calls);
		expect([switchedOff.status, unknown.status]).toStrictEqual([204, 204]);
		expect(switchedOff.body).toBe(unknown.body);
		expect(switchedOff.sends).toStrictEqual(["request_for_unknown_address"]);
		expect(bench.sent).toStrictEqual([
			{ kind: "request_for_unknown_address", to: UNKNOWN, requested: "passkey_recovery" },
		]);
	});

	it("answers a known address as an unknown one and sends it its link once", async () => {
		const account = await signUp(bench);

		const known = await observedRequest(account.email);
		const unknown = await observedRequest(UNKNOWN);

		expect([known.status, known.body]).toStrictEqual([unknown.status, unknown.body]);
		expect(known.sends).toStrictEqual(["passkey_recovery"]);
		expect(known.calls.map((call) => call.parameterCount)).toStrictEqual(
			unknown.calls.map((call) => call.parameterCount),
		);
	});
});

describe("every failing step after the request gives one answer (S-ENUM-10)", () => {
	it("answers an invented link, a wrong code, a switched-off, a disabled and an already recovering account alike", async () => {
		const wrongCode = await signUp(bench);
		const [wrongCodesFirst] = await generateCodes(bench, wrongCode);
		const wrongCodeLink = await mailedRecoveryLink(bench, wrongCode.email);

		const disabled = await signUp(bench);
		const [disabledCode] = await generateCodes(bench, disabled);
		const disabledLink = await mailedRecoveryLink(bench, disabled.email);
		await bench.auth.user.disable({ userId: disabled.userId, reason: "test" });

		const pending = await signUp(bench);
		const pendingCodes = await generateCodes(bench, pending);
		expect(
			(await recoverTo(bench, pending, pendingCodes[0] ?? "", await newAuthenticator())).status,
		).toBe(200);
		const pendingLink = await mailedRecoveryLink(bench, pending.email);

		const answers = [
			await startRecovery(bench, "an-invented-link-that-names-nothing", wrongCodesFirst ?? ""),
			await startRecovery(bench, wrongCodeLink, "AAAAA-BBBBB-CCCCC-DDDDD"),
			await startRecovery(bench, disabledLink, disabledCode ?? ""),
			await startRecovery(bench, pendingLink, pendingCodes[1] ?? ""),
			await finishRecovery(bench, "an-invented-challenge", {}),
		];
		const bodies = await Promise.all(answers.map((answer) => answer.text()));

		expect(answers.map((answer) => answer.status)).toStrictEqual([400, 400, 400, 400, 400]);
		expect(new Set(bodies).size).toBe(1);
		expect(JSON.parse(bodies[0] ?? "{}")).toStrictEqual({
			error: { code: "passkey_recovery_failed", message: "The recovery could not be continued." },
		});
		// a failing step spends nothing: the right code still opens the recovery with the same link
		expect(await countOf(bench, "recovery_code", wrongCode.userId)).toBe(10);
		expect((await startRecovery(bench, wrongCodeLink, wrongCodesFirst ?? "")).status).toBe(200);
		expect(await countOf(bench, "recovery_code", pending.userId)).toBe(9);
	}, 30_000);

	it("answers a registration that fails its ceremony as every other failing step", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		const token = await mailedRecoveryLink(bench, account.email);
		const started = await startedRecovery(bench, token, code ?? "");
		const authenticator = await newAuthenticator();
		const unverified = await authenticator.attest({
			challenge: started.challengeToken,
			flags: { userVerified: false },
		});

		const answer = await finishRecovery(bench, started.challengeToken, unverified);

		expect([answer.status, await errorCodeOf(answer)]).toStrictEqual([
			400,
			"passkey_recovery_failed",
		]);
		expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(0);
	});

	it("refuses a challenge a registration in a session was issued, so no session ceremony starts a recovery", async () => {
		const account = await signUp(bench);
		const started = await bench.handler(
			postTo("/factor/webauthn/register/start", {}, withSession(account.sessionToken)),
		);
		const { challengeToken } = (await started.json()) as { challengeToken: string };
		const response = await (await newAuthenticator()).attest({ challenge: challengeToken });

		const answer = await finishRecovery(bench, challengeToken, response);

		expect(await errorCodeOf(answer)).toBe("passkey_recovery_failed");
		expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(0);
	});
});

describe("concurrent attempts leave one winner (S-RACE-7)", () => {
	it("spends one link and one code once when two starts present them together", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		const token = await mailedRecoveryLink(bench, account.email);

		const answers = await Promise.all(
			Array.from({ length: 4 }, () => startRecovery(bench, token, code ?? "")),
		);

		expect(answers.map((answer) => answer.status).sort()).toStrictEqual([200, 400, 400, 400]);
		expect(await countOf(bench, "recovery_code", account.userId)).toBe(9);
	});

	it("consumes one code once when two links of the account present it together", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		const first = await mailedRecoveryLink(bench, account.email);
		const firstStarted = await startRecovery(bench, first, code ?? "");
		const second = await mailedRecoveryLink(bench, account.email);

		expect(firstStarted.status).toBe(200);
		expect((await startRecovery(bench, second, code ?? "")).status).toBe(400);
		expect(await countOf(bench, "recovery_code", account.userId)).toBe(9);
	});

	it("holds at most one recovery per account when two registrations finish together", async () => {
		const account = await signUp(bench);
		const codes = await generateCodes(bench, account);
		const ceremonies = [];
		for (const code of codes.slice(0, 3)) {
			const token = await mailedRecoveryLink(bench, account.email);
			const started = await startedRecovery(bench, token, code);
			const authenticator = await newAuthenticator();
			ceremonies.push({
				challengeToken: started.challengeToken,
				response: await authenticator.attest({ challenge: started.challengeToken }),
			});
		}

		const answers = await Promise.all(
			ceremonies.map((ceremony) =>
				finishRecovery(bench, ceremony.challengeToken, ceremony.response),
			),
		);

		expect(answers.map((answer) => answer.status).sort()).toStrictEqual([200, 400, 400]);
		expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(1);
		expect(
			bench.sent.filter((message) => message.kind === "passkey_recovery_started"),
		).toHaveLength(1);
	}, 30_000);

	it("mails a new link that replaces the one before it", async () => {
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		const first = await mailedRecoveryLink(bench, account.email);
		await requestRecovery(bench, account.email);

		expect(lastRecoveryLinkTo(bench, account.email)).not.toBe(first);
		expect(await errorCodeOf(await startRecovery(bench, first, code ?? ""))).toBe(
			"passkey_recovery_failed",
		);
	});
});
