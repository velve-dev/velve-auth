import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
	signInWithPasskey,
	signUp,
	startedRecovery,
	withSession,
} from "./passkey-recovery-fixtures.js";
import type { VirtualAuthenticator } from "./webauthn-simulator.js";

/**
 * T-DEFAULT-8 over HTTP: one instance with `webauthn.requireDiscoverableCredential` and the
 * recovery to a new passkey configured. A registration in a session whose client does not report
 * a discoverable credential answers `webauthn_credential_not_discoverable`; the registration that
 * ends a recovery answers its own uniform `passkey_recovery_failed`, byte for byte as an unknown
 * challenge does; neither leaves a row, and the recovery's challenge survives its refusal (E-3782).
 */

let bench: RecoveryBench;
let waitingPeriodInSeconds = 3600;

beforeAll(async () => {
	bench = await openRecoveryBench("discoverable_flow", {
		webauthn: {
			relyingPartyId: "app.example.com",
			relyingPartyName: "Velve Auth tests",
			origins: [TEST_ORIGIN],
			userVerification: "required",
			requireDiscoverableCredential: true,
			recovery: { waitingPeriodInSeconds: () => waitingPeriodInSeconds },
		},
	});
}, 60_000);

afterAll(async () => {
	await bench.close();
});

function discoverable(response: RegistrationResponseJSON): RegistrationResponseJSON {
	return { ...response, clientExtensionResults: { credProps: { rk: true } } };
}

function notDiscoverable(response: RegistrationResponseJSON): RegistrationResponseJSON {
	return { ...response, clientExtensionResults: { credProps: { rk: false } } };
}

interface StartedRegistration {
	readonly challengeToken: string;
	readonly publicKeyOptions: {
		readonly authenticatorSelection?: Record<string, unknown>;
		readonly extensions?: Record<string, unknown>;
	};
}

async function startRegistration(sessionToken: string): Promise<StartedRegistration> {
	const answer = await bench.handler(
		postTo("/factor/webauthn/register/start", {}, withSession(sessionToken)),
	);
	expect(answer.status).toBe(200);
	return (await answer.json()) as StartedRegistration;
}

function finishRegistration(
	sessionToken: string,
	challengeToken: string,
	response: RegistrationResponseJSON,
): Promise<Response> {
	return bench.handler(
		postTo(
			"/factor/webauthn/register/finish",
			{ challengeToken, response, label: "a key" },
			withSession(sessionToken),
		),
	);
}

describe("a registration in a session (S-DEFAULT-8)", () => {
	it("asks for a discoverable credential with user verification and the credProps extension", async () => {
		const account = await signUp(bench);
		const started = await startRegistration(account.sessionToken);

		expect(started.publicKeyOptions.authenticatorSelection).toMatchObject({
			residentKey: "required",
			userVerification: "required",
		});
		expect(started.publicKeyOptions.extensions).toMatchObject({ credProps: true });
	});

	it("refuses a credential its client does not report as discoverable, and stores nothing", async () => {
		const account = await signUp(bench);
		const authenticator = await newAuthenticator();
		const started = await startRegistration(account.sessionToken);
		const attested = await authenticator.attest({ challenge: started.challengeToken });

		const refused = await finishRegistration(
			account.sessionToken,
			started.challengeToken,
			notDiscoverable(attested),
		);
		const retried = await finishRegistration(
			account.sessionToken,
			started.challengeToken,
			discoverable(attested),
		);

		expect(refused.status).toBe(400);
		expect(await refused.json()).toStrictEqual({
			error: {
				code: "webauthn_credential_not_discoverable",
				message: "The authenticator did not report a discoverable credential.",
			},
		});
		expect([retried.status, await errorCodeOf(retried)]).toStrictEqual([
			400,
			"webauthn_challenge_invalid",
		]);
		expect(await countOf(bench, "webauthn_credential", account.userId)).toBe(0);
	});

	it("refuses a response that carries no extension results, as a browser that drops them sends", async () => {
		const account = await signUp(bench);
		const authenticator = await newAuthenticator();
		const started = await startRegistration(account.sessionToken);
		const { clientExtensionResults: _dropped, ...withoutResults } = await authenticator.attest({
			challenge: started.challengeToken,
		});

		const refused = await finishRegistration(
			account.sessionToken,
			started.challengeToken,
			withoutResults as RegistrationResponseJSON,
		);

		expect([refused.status, await errorCodeOf(refused)]).toStrictEqual([
			400,
			"webauthn_credential_not_discoverable",
		]);
		expect(await countOf(bench, "webauthn_credential", account.userId)).toBe(0);
	});

	it("registers a reported discoverable credential, which then signs in without an address", async () => {
		const account = await signUp(bench);
		const authenticator = await newAuthenticator();
		const started = await startRegistration(account.sessionToken);
		const attested = await authenticator.attest({ challenge: started.challengeToken });

		const finished = await finishRegistration(
			account.sessionToken,
			started.challengeToken,
			discoverable(attested),
		);
		const signedIn = await signInWithPasskey(bench, authenticator);

		expect(finished.status).toBe(200);
		expect(signedIn.status).toBe(200);
		expect(await countOf(bench, "webauthn_credential", account.userId)).toBe(1);
	});

	it("refuses an attestation without user verification even with rk reported", async () => {
		const account = await signUp(bench);
		const authenticator = await newAuthenticator();
		const started = await startRegistration(account.sessionToken);
		const attested = await authenticator.attest({
			challenge: started.challengeToken,
			flags: { userVerified: false },
		});

		const refused = await finishRegistration(
			account.sessionToken,
			started.challengeToken,
			discoverable(attested),
		);

		expect([refused.status, await errorCodeOf(refused)]).toStrictEqual([
			401,
			"webauthn_credential_rejected",
		]);
		expect(await countOf(bench, "webauthn_credential", account.userId)).toBe(0);
	});
});

interface RecoveryUnderway {
	readonly userId: string;
	readonly challengeToken: string;
	readonly authenticator: VirtualAuthenticator;
	readonly publicKeyOptions: Record<string, unknown>;
}

async function recoveryUnderway(): Promise<RecoveryUnderway> {
	const account = await signUp(bench);
	const codes = await generateCodes(bench, account);
	const token = await mailedRecoveryLink(bench, account.email);
	const started = await startedRecovery(bench, token, codes[0] ?? "");
	return {
		userId: account.userId,
		challengeToken: started.challengeToken,
		authenticator: await newAuthenticator(),
		publicKeyOptions: started.publicKeyOptions as Record<string, unknown>,
	};
}

describe("the registration that ends a recovery (S-DEFAULT-8, S-ENUM-10)", () => {
	it("asks for a discoverable credential with user verification and the credProps extension", async () => {
		const underway = await recoveryUnderway();

		expect(underway.publicKeyOptions.authenticatorSelection).toMatchObject({
			residentKey: "required",
			userVerification: "required",
		});
		expect(underway.publicKeyOptions.extensions).toMatchObject({ credProps: true });
	});

	it("answers a credential not reported as discoverable as any failed step, and holds nothing", async () => {
		const underway = await recoveryUnderway();
		const attested = await underway.authenticator.attest({ challenge: underway.challengeToken });

		const refused = await finishRecovery(bench, underway.challengeToken, notDiscoverable(attested));
		const unknown = await finishRecovery(bench, "an-unknown-challenge", discoverable(attested));

		expect(refused.status).toBe(400);
		expect(refused.headers.get("content-type")).toBe(unknown.headers.get("content-type"));
		expect(await refused.text()).toBe(await unknown.text());
		expect(await countOf(bench, "passkey_recovery", underway.userId)).toBe(0);
		expect(await countOf(bench, "webauthn_credential", underway.userId)).toBe(0);
		expect(await countOf(bench, "recovery_code", underway.userId)).toBe(9);
	});

	it("keeps the challenge through the refusal, so the same recovery finishes with a discoverable one", async () => {
		const underway = await recoveryUnderway();
		const refusedResponse = await underway.authenticator.attest({
			challenge: underway.challengeToken,
		});
		const refused = await finishRecovery(
			bench,
			underway.challengeToken,
			notDiscoverable(refusedResponse),
		);
		const another = await newAuthenticator();
		const accepted = await finishRecovery(
			bench,
			underway.challengeToken,
			discoverable(await another.attest({ challenge: underway.challengeToken })),
		);

		expect([refused.status, await errorCodeOf(refused)]).toStrictEqual([
			400,
			"passkey_recovery_failed",
		]);
		expect(accepted.status).toBe(200);
		expect(await countOf(bench, "passkey_recovery", underway.userId)).toBe(1);
		expect(await countOf(bench, "recovery_code", underway.userId)).toBe(9);
	});

	it("answers an attestation without user verification as any failed step, and holds nothing", async () => {
		const underway = await recoveryUnderway();
		const attested = await underway.authenticator.attest({
			challenge: underway.challengeToken,
			flags: { userVerified: false },
		});

		const refused = await finishRecovery(bench, underway.challengeToken, discoverable(attested));

		expect([refused.status, await errorCodeOf(refused)]).toStrictEqual([
			400,
			"passkey_recovery_failed",
		]);
		expect(await countOf(bench, "passkey_recovery", underway.userId)).toBe(0);
	});

	it("replaces every way in with the new passkey when the waiting period is zero", async () => {
		waitingPeriodInSeconds = 0;
		try {
			const underway = await recoveryUnderway();
			const attested = await underway.authenticator.attest({ challenge: underway.challengeToken });

			const refused = await finishRecovery(
				bench,
				underway.challengeToken,
				notDiscoverable(attested),
			);
			const accepted = await finishRecovery(bench, underway.challengeToken, discoverable(attested));
			const signedIn = await signInWithPasskey(bench, underway.authenticator);

			expect([refused.status, accepted.status, signedIn.status]).toStrictEqual([400, 200, 200]);
			expect(await countOf(bench, "webauthn_credential", underway.userId)).toBe(1);
		} finally {
			waitingPeriodInSeconds = 3600;
		}
	});
});
