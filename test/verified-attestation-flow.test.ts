import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_ORIGIN } from "./auth-fixtures.js";
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
	signInWithPasskey,
	signUp,
	startedRecovery,
	withSession,
} from "./passkey-recovery-fixtures.js";
import {
	type AttestationKind,
	createAttestingAuthenticator,
	createTestCertificateAuthority,
	type TestCertificateAuthority,
} from "./verified-attestation-fixtures.js";
import type { VirtualAuthenticator } from "./webauthn-simulator.js";

/**
 * S-INTEG-13 over HTTP and the instance: `user.limitAuthenticators` and `liftAuthenticatorLimit`
 * as the application calls them, the registration in a session refused with
 * `authenticator_not_allowed`, the passkey sign-in that answers a passkey outside the list byte for
 * byte as an unknown one, the recovery to a new passkey that keeps its uniform failure, the held
 * back passkey a new list withdraws, and the administrator reseal that never ratifies a list or an
 * attestation the seal does not confirm.
 */

const ALLOWED = "2fc0579f-8113-47ea-b116-bb5a8db9202a";
const OTHER = "cb69481e-8ff7-4039-93ec-0a2729a154a8";

let authority: TestCertificateAuthority;
let bench: RecoveryBench;
let off: RecoveryBench;

function webauthnOf(attested: boolean, roots: readonly string[]) {
	return {
		relyingPartyId: "app.example.com",
		relyingPartyName: "Velve Auth tests",
		origins: [TEST_ORIGIN],
		userVerification: "required" as const,
		...(attested ? { attestation: { trustedRoots: roots } } : {}),
		recovery: { waitingPeriodInSeconds: () => bench.waitingPeriod as number },
	};
}

beforeAll(async () => {
	authority = await createTestCertificateAuthority();
	bench = await openRecoveryBench("attest_flow", {
		webauthn: webauthnOf(true, [authority.rootPem]),
	});
	off = await openRecoveryBench("attest_flow_off", { webauthn: webauthnOf(false, []) });
}, 60_000);

afterAll(async () => {
	await bench.close();
	await off.close();
});

async function attesting(aaguid: string, kind: "packed" | "none"): Promise<VirtualAuthenticator> {
	const attestation: AttestationKind =
		kind === "packed"
			? { kind: "packed", identity: await authority.issue({ aaguid }) }
			: { kind: "none" };
	return createAttestingAuthenticator({
		relyingPartyId: "app.example.com",
		origin: TEST_ORIGIN,
		aaguid,
		attestation,
	});
}

interface Started {
	readonly challengeToken: string;
	readonly publicKeyOptions: { readonly attestation?: string };
}

async function startRegistration(on: RecoveryBench, sessionToken: string): Promise<Started> {
	const answer = await on.handler(
		postTo("/factor/webauthn/register/start", {}, withSession(sessionToken)),
	);
	expect(answer.status).toBe(200);
	return (await answer.json()) as Started;
}

async function registerOver(
	on: RecoveryBench,
	sessionToken: string,
	authenticator: VirtualAuthenticator,
): Promise<Response> {
	const started = await startRegistration(on, sessionToken);
	const response: RegistrationResponseJSON = await authenticator.attest({
		challenge: started.challengeToken,
	});
	return on.handler(
		postTo(
			"/factor/webauthn/register/finish",
			{ challengeToken: started.challengeToken, response, label: "key" },
			withSession(sessionToken),
		),
	);
}

async function codeOf(attempt: Promise<unknown>): Promise<string> {
	try {
		await attempt;
	} catch (cause) {
		return String((cause as { code?: unknown }).code);
	}
	return "resolved";
}

describe("user.limitAuthenticators and liftAuthenticatorLimit (S-INTEG-13)", () => {
	it("refuses a list it cannot hold to and an account it cannot name with invalid_input", async () => {
		const account = await signUp(bench);
		const limit = bench.auth.user.limitAuthenticators;
		const refused = [
			limit({ userId: account.userId, aaguids: [] }),
			limit({ userId: account.userId, aaguids: ["not-an-aaguid"] }),
			limit({ userId: account.userId, aaguids: ["00000000-0000-0000-0000-000000000000"] }),
			limit({
				userId: account.userId,
				aaguids: [ALLOWED],
				allowNoUsableSignInMethod: "yes" as unknown as boolean,
			}),
			limit({ userId: "no-account", aaguids: [ALLOWED] }),
			limit({ userId: crypto.randomUUID(), aaguids: [ALLOWED] }),
		];
		for (const attempt of refused) {
			expect(await codeOf(attempt)).toBe("invalid_input");
		}
	});

	it("is refused where no roots are configured, since no passkey could satisfy a list", async () => {
		const account = await signUp(off);
		expect(
			await codeOf(
				off.auth.user.limitAuthenticators({ userId: account.userId, aaguids: [ALLOWED] }),
			),
		).toBe("invalid_input");
		const started = await startRegistration(off, account.sessionToken);
		expect(started.publicKeyOptions.attestation).toBe("none");
	});

	it("is logged on the operator's sink when it is set and when it is lifted", async () => {
		const account = await signUp(bench);
		await bench.auth.user.limitAuthenticators({
			userId: account.userId,
			aaguids: [ALLOWED.toUpperCase(), ALLOWED],
		});
		await bench.auth.user.liftAuthenticatorLimit({ userId: account.userId });
		const messages = bench.log.lines
			.filter((line) => line.fields.userId === account.userId)
			.map((line) => [line.message, line.fields.aaguids]);
		expect(messages).toEqual([
			["account authenticators limited", [ALLOWED]],
			["account authenticator limit lifted", null],
		]);
	});
});

describe("registration in a session under a list (S-INTEG-13)", () => {
	it("asks for direct attestation and refuses an unverified authenticator with 403 and no row", async () => {
		const account = await signUp(bench);
		await bench.auth.user.limitAuthenticators({ userId: account.userId, aaguids: [ALLOWED] });
		const started = await startRegistration(bench, account.sessionToken);
		expect(started.publicKeyOptions.attestation).toBe("direct");
		const refused = await registerOver(
			bench,
			account.sessionToken,
			await attesting(ALLOWED, "none"),
		);
		expect(refused.status).toBe(403);
		expect(await errorCodeOf(refused)).toBe("authenticator_not_allowed");
		const outside = await registerOver(
			bench,
			account.sessionToken,
			await attesting(OTHER, "packed"),
		);
		expect(await errorCodeOf(outside)).toBe("authenticator_not_allowed");
		expect(await countOf(bench, "webauthn_credential", account.userId)).toBe(0);
		const accepted = await registerOver(
			bench,
			account.sessionToken,
			await attesting(ALLOWED, "packed"),
		);
		expect(accepted.status).toBe(200);
		const body = (await accepted.json()) as { credential: { attestationVerified: boolean } };
		expect(body.credential.attestationVerified).toBe(true);
	});
});

describe("passkey sign-in under a list (S-INTEG-13)", () => {
	it("answers a passkey outside the list byte for byte as a passkey nobody registered", async () => {
		const account = await signUp(bench);
		const outside = await attesting(OTHER, "packed");
		expect((await registerOver(bench, account.sessionToken, outside)).status).toBe(200);
		expect((await signInWithPasskey(bench, outside)).status).toBe(200);
		await bench.auth.user.limitAuthenticators({ userId: account.userId, aaguids: [ALLOWED] });
		const refused = await signInWithPasskey(bench, outside);
		const unknown = await signInWithPasskey(bench, await newAuthenticator());
		expect(refused.status).toBe(unknown.status);
		expect(await refused.text()).toBe(await unknown.text());
		await bench.auth.user.liftAuthenticatorLimit({ userId: account.userId });
		expect((await signInWithPasskey(bench, outside)).status).toBe(200);
	});
});

describe("the recovery to a new passkey under a list (S-INTEG-13, S-ENUM-10)", () => {
	it("asks for attestation, fails an authenticator outside the list as one and accepts one on it", async () => {
		bench.waitingPeriod = 0;
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		await bench.auth.user.limitAuthenticators({ userId: account.userId, aaguids: [ALLOWED] });
		const token = await mailedRecoveryLink(bench, account.email);
		const started = await startedRecovery(bench, token, code ?? "");
		expect((started.publicKeyOptions as { attestation?: string }).attestation).toBe("direct");
		const outside = await (await attesting(ALLOWED, "none")).attest({
			challenge: started.challengeToken,
		});
		const refused = await finishRecovery(bench, started.challengeToken, outside);
		const unknownChallenge = await finishRecovery(bench, "an-unknown-challenge", outside);
		expect(refused.status).toBe(400);
		expect(await refused.text()).toBe(await unknownChallenge.text());
		expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(0);
		const inside = await attesting(ALLOWED, "packed");
		const accepted = await finishRecovery(
			bench,
			started.challengeToken,
			await inside.attest({ challenge: started.challengeToken }),
		);
		expect(accepted.status).toBe(200);
		expect((await signInWithPasskey(bench, inside)).status).toBe(200);
	});

	it("withdraws a held back passkey a new list does not allow, so it never activates", async () => {
		bench.waitingPeriod = 3600;
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		const token = await mailedRecoveryLink(bench, account.email);
		const started = await startedRecovery(bench, token, code ?? "");
		expect((started.publicKeyOptions as { attestation?: string }).attestation).toBe("none");
		const held = await finishRecovery(
			bench,
			started.challengeToken,
			await (await attesting(ALLOWED, "none")).attest({ challenge: started.challengeToken }),
		);
		expect(held.status).toBe(200);
		expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(1);
		await bench.auth.user.limitAuthenticators({ userId: account.userId, aaguids: [ALLOWED] });
		expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(0);
		const pending = await bench.handler(
			getFrom("/passkey-recovery", withSession(account.sessionToken)),
		);
		expect(await pending.json()).toBeNull();
	});
});

describe("the administrator reseal (S-INTEG-7, S-INTEG-13)", () => {
	async function listedAccount() {
		const account = await signUp(bench);
		const inside = await attesting(ALLOWED, "packed");
		expect((await registerOver(bench, account.sessionToken, inside)).status).toBe(200);
		await bench.auth.user.limitAuthenticators({ userId: account.userId, aaguids: [ALLOWED] });
		return { account, inside };
	}

	it("keeps a list and an attestation the seal confirms and reports both", async () => {
		const { account } = await listedAccount();
		const sealed = await bench.auth.maintenance.resealSecurityState({
			userId: account.userId,
			reason: "routine",
		});
		expect(sealed.authenticatorAllowlist).toEqual([ALLOWED]);
		expect(sealed.attestedPasskeyCredentialIds).toHaveLength(1);
	});

	it("refuses to ratify a list a writer removed until the operator names it, and then drops every unconfirmed attestation", async () => {
		const { account, inside } = await listedAccount();
		await bench.migrated.connection.query(
			`UPDATE ${bench.migrated.schema}.user SET allowed_aaguids = NULL WHERE id = $1`,
			[account.userId],
		);
		expect(
			await codeOf(
				bench.auth.maintenance.resealSecurityState({
					userId: account.userId,
					reason: "incident",
					recoveryDisabled: false,
				}),
			),
		).toBe("security_state_authenticator_allowlist_unconfirmed");
		const sealed = await bench.auth.maintenance.resealSecurityState({
			userId: account.userId,
			reason: "incident",
			recoveryDisabled: false,
			authenticatorAllowlist: [ALLOWED],
		});
		expect(sealed.authenticatorAllowlist).toEqual([ALLOWED]);
		expect(sealed.attestedPasskeyCredentialIds).toEqual([]);
		const [row] = await bench.migrated.connection.query<{ verified: boolean }>(
			`SELECT attestation_verified AS verified FROM ${bench.migrated.schema}.webauthn_credential WHERE user_id = $1`,
			[account.userId],
		);
		expect(row?.verified).toBe(false);
		expect((await signInWithPasskey(bench, inside)).status).toBe(401);
	});
});
