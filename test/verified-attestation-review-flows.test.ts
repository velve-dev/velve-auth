import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { TEST_ORIGIN } from "./auth-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import {
	countOf,
	finishRecovery,
	generateCodes,
	mailedRecoveryLink,
	newAuthenticator,
	openRecoveryBench,
	type RecoveryBench,
	signInWithPasskey,
	signInWithPassword,
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
 * Reviewer's cases for S-INTEG-13 over HTTP and the instance, written against the requirement:
 * the passkey as a second factor outside the list answers as an unknown one and moves nothing, an
 * account whose only second factor lies outside the list does not fall back to one factor, a
 * writer who moves another account's attested passkey in or widens the list gains nothing from
 * either maintenance step, a recovery with a waiting period never holds a passkey outside the
 * list, accounts without a list are asked for no attestation, and the server-only methods refuse
 * every input they cannot hold to with one code.
 */

const ALLOWED = "2fc0579f-8113-47ea-b116-bb5a8db9202a";
const OTHER = "cb69481e-8ff7-4039-93ec-0a2729a154a8";
const RELYING_PARTY_ID = "app.example.com";

let authority: TestCertificateAuthority;
let bench: RecoveryBench;
let off: RecoveryBench;

function webauthnOf(roots: readonly string[] | null) {
	return {
		relyingPartyId: RELYING_PARTY_ID,
		relyingPartyName: "Velve Auth tests",
		origins: [TEST_ORIGIN],
		userVerification: "required" as const,
		...(roots === null ? {} : { attestation: { trustedRoots: roots } }),
		recovery: { waitingPeriodInSeconds: () => bench.waitingPeriod as number },
	};
}

beforeAll(async () => {
	authority = await createTestCertificateAuthority();
	bench = await openRecoveryBench("attest_review_flows", {
		webauthn: webauthnOf([authority.rootPem]),
	});
	off = await openRecoveryBench("attest_review_off", { webauthn: webauthnOf(null) });
}, 60_000);

afterAll(async () => {
	await bench.close();
	await off.close();
});

beforeEach(() => {
	bench.waitingPeriod = 0;
});

async function attesting(aaguid: string, kind: "packed" | "none"): Promise<VirtualAuthenticator> {
	const attestation: AttestationKind =
		kind === "packed"
			? { kind: "packed", identity: await authority.issue({ aaguid }) }
			: { kind: "none" };
	return createAttestingAuthenticator({
		relyingPartyId: RELYING_PARTY_ID,
		origin: TEST_ORIGIN,
		aaguid,
		attestation,
	});
}

interface Started {
	readonly challengeToken: string;
	readonly publicKeyOptions: Record<string, unknown>;
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

async function secondFactorWith(
	email: string,
	authenticator: VirtualAuthenticator,
): Promise<Response> {
	const signedIn = await signInWithPassword(bench, email);
	const pending = cookieIn(signedIn, DEFAULT_COOKIE_NAMES.pending);
	expect(pending).not.toBeNull();
	expect(cookieIn(signedIn, DEFAULT_COOKIE_NAMES.session)).toBeNull();
	const started = await bench.handler(
		postTo("/factor/webauthn/authenticate/start", {}, withPending(pending ?? "")),
	);
	const { challengeToken } = (await started.json()) as { challengeToken: string };
	const response = await authenticator.assert({ challenge: challengeToken });
	return bench.handler(
		postTo(
			"/factor/webauthn/authenticate/finish",
			{ challengeToken, response },
			withPending(pending ?? ""),
		),
	);
}

async function credentialRowsOf(userId: string) {
	return bench.migrated.connection.query<{
		id: string;
		sign_count: string;
		last_used_at: string | null;
		verified: boolean;
	}>(
		`SELECT id::text, sign_count::text, last_used_at::text, attestation_verified AS verified
		 FROM ${bench.migrated.schema}.webauthn_credential WHERE user_id = $1 ORDER BY id`,
		[userId],
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

describe("the passkey as a second factor outside the list (S-INTEG-13)", () => {
	it("answers byte for byte as an unknown passkey, moves no counter and never falls back to one factor", async () => {
		const account = await signUp(bench);
		const outside = await attesting(OTHER, "packed");
		expect((await registerOver(bench, account.sessionToken, outside)).status).toBe(200);
		await bench.auth.user.limitAuthenticators({ userId: account.userId, aaguids: [ALLOWED] });
		const before = await credentialRowsOf(account.userId);

		const refused = await secondFactorWith(account.email, outside);
		const unknown = await secondFactorWith(account.email, await newAuthenticator());

		expect(refused.status).toBe(unknown.status);
		expect(await refused.text()).toBe(await unknown.text());
		expect(cookieIn(refused, DEFAULT_COOKIE_NAMES.session)).toBeNull();
		expect(await credentialRowsOf(account.userId)).toStrictEqual(before);
	});
});

describe("a writer without the root key against both maintenance steps (S-INTEG-13, S-INTEG-7)", () => {
	async function listedAccount() {
		const account = await signUp(bench);
		const inside = await attesting(ALLOWED, "packed");
		expect((await registerOver(bench, account.sessionToken, inside)).status).toBe(200);
		await bench.auth.user.limitAuthenticators({ userId: account.userId, aaguids: [ALLOWED] });
		return { account, inside };
	}

	it("gains no sign-in by moving another account's attested passkey into a listed account", async () => {
		const { account: victim } = await listedAccount();
		const attacker = await signUp(bench);
		const attackersKey = await attesting(ALLOWED, "packed");
		expect((await registerOver(bench, attacker.sessionToken, attackersKey)).status).toBe(200);
		await bench.migrated.connection.query(
			`UPDATE ${bench.migrated.schema}.webauthn_credential SET user_id = $1 WHERE user_id = $2`,
			[victim.userId, attacker.userId],
		);

		expect((await signInWithPasskey(bench, attackersKey)).status).toBe(401);

		const report = await bench.auth.maintenance.sealSecurityState();
		expect(report.refusedUserIds).toContain(victim.userId);
		expect((await signInWithPasskey(bench, attackersKey)).status).toBe(401);

		expect(
			await codeOf(
				bench.auth.maintenance.resealSecurityState({
					userId: victim.userId,
					reason: "incident",
					recoveryDisabled: false,
				}),
			),
		).toBe("security_state_authenticator_allowlist_unconfirmed");
		const sealed = await bench.auth.maintenance.resealSecurityState({
			userId: victim.userId,
			reason: "incident",
			recoveryDisabled: false,
			authenticatorAllowlist: [ALLOWED],
		});
		expect(sealed.attestedPasskeyCredentialIds).toStrictEqual([]);
		expect((await signInWithPasskey(bench, attackersKey)).status).toBe(401);
	});

	it("gains no sign-in by widening the list, through either maintenance step", async () => {
		const { account } = await listedAccount();
		const outside = await attesting(OTHER, "packed");
		await bench.auth.user.liftAuthenticatorLimit({ userId: account.userId });
		expect((await registerOver(bench, account.sessionToken, outside)).status).toBe(200);
		await bench.auth.user.limitAuthenticators({ userId: account.userId, aaguids: [ALLOWED] });
		expect((await signInWithPasskey(bench, outside)).status).toBe(401);

		await bench.migrated.connection.query(
			`UPDATE ${bench.migrated.schema}.user SET allowed_aaguids = allowed_aaguids || $2::uuid WHERE id = $1`,
			[account.userId, OTHER],
		);
		expect((await signInWithPasskey(bench, outside)).status).toBe(401);
		const report = await bench.auth.maintenance.sealSecurityState();
		expect(report.refusedUserIds).toContain(account.userId);
		expect(
			await codeOf(
				bench.auth.maintenance.resealSecurityState({
					userId: account.userId,
					reason: "incident",
					recoveryDisabled: false,
				}),
			),
		).toBe("security_state_authenticator_allowlist_unconfirmed");
		expect((await signInWithPasskey(bench, outside)).status).toBe(401);
	});

	it("gains no sign-in by flipping the flag of a passkey on an account that never had a list", async () => {
		const account = await signUp(bench);
		const unattested = await attesting(ALLOWED, "none");
		expect((await registerOver(bench, account.sessionToken, unattested)).status).toBe(200);
		await bench.migrated.connection.query(
			`UPDATE ${bench.migrated.schema}.webauthn_credential SET attestation_verified = true WHERE user_id = $1`,
			[account.userId],
		);
		expect((await signInWithPasskey(bench, unattested)).status).toBe(401);
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
			authenticatorAllowlist: null,
		});
		expect(sealed.attestedPasskeyCredentialIds).toStrictEqual([]);
		const [row] = await credentialRowsOf(account.userId);
		expect(row?.verified).toBe(false);
	});
});

describe("the recovery with a waiting period under a list (S-INTEG-13, S-ENUM-10)", () => {
	it("holds no passkey outside the list and fails as an unknown challenge does", async () => {
		bench.waitingPeriod = 3600;
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		await bench.auth.user.limitAuthenticators({ userId: account.userId, aaguids: [ALLOWED] });
		const started = await startedRecovery(
			bench,
			await mailedRecoveryLink(bench, account.email),
			code ?? "",
		);
		for (const outside of [await attesting(OTHER, "packed"), await attesting(ALLOWED, "none")]) {
			const response = await outside.attest({ challenge: started.challengeToken });
			const refused = await finishRecovery(bench, started.challengeToken, response);
			const unknown = await finishRecovery(bench, "an-unknown-challenge", response);
			expect(refused.status).toBe(unknown.status);
			expect(await refused.text()).toBe(await unknown.text());
			expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(0);
		}
	});
});

describe("the activation of a held passkey on the list (S-INTEG-13, S-INTEG-12)", () => {
	it("activates it after the waiting period with the list and its attestation still sealed", async () => {
		bench.waitingPeriod = 1;
		const account = await signUp(bench);
		const [code] = await generateCodes(bench, account);
		await bench.auth.user.limitAuthenticators({ userId: account.userId, aaguids: [ALLOWED] });
		const started = await startedRecovery(
			bench,
			await mailedRecoveryLink(bench, account.email),
			code ?? "",
		);
		const inside = await attesting(ALLOWED, "packed");
		const held = await finishRecovery(
			bench,
			started.challengeToken,
			await inside.attest({ challenge: started.challengeToken }),
		);
		expect(held.status).toBe(200);
		expect(await countOf(bench, "passkey_recovery", account.userId)).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		expect((await signInWithPasskey(bench, inside)).status).toBe(200);
		expect((await signInWithPasskey(bench, inside)).status).toBe(200);
		const sealed = await bench.auth.maintenance.resealSecurityState({
			userId: account.userId,
			reason: "read back",
		});
		expect(sealed.authenticatorAllowlist).toStrictEqual([ALLOWED]);
		expect(sealed.attestedPasskeyCredentialIds).toHaveLength(1);
	});
});

describe("an account without a list (S-INTEG-13)", () => {
	function shapeOf(options: Record<string, unknown>): Record<string, unknown> {
		const { challenge: _challenge, user: _user, ...rest } = options;
		return rest;
	}

	it("is asked for no attestation and the same options whether or not roots are configured", async () => {
		const configured = await signUp(bench);
		const plain = await signUp(off);
		const withRoots = await startRegistration(bench, configured.sessionToken);
		const withoutRoots = await startRegistration(off, plain.sessionToken);
		expect(withRoots.publicKeyOptions.attestation).toBe("none");
		expect(shapeOf(withRoots.publicKeyOptions)).toStrictEqual(
			shapeOf(withoutRoots.publicKeyOptions),
		);
		const credential = await attesting(ALLOWED, "packed");
		expect((await registerOver(off, plain.sessionToken, credential)).status).toBe(200);
		expect((await signInWithPasskey(off, credential)).status).toBe(200);
	});
});

describe("user.limitAuthenticators refuses what it cannot hold to (S-INTEG-13)", () => {
	it("answers invalid_input for every malformed call and keeps one spelling of a valid list", async () => {
		const account = await signUp(bench);
		const malformed: readonly unknown[] = [
			{ userId: account.userId, aaguids: [ALLOWED, 7] },
			{ userId: account.userId, aaguids: `${ALLOWED}` },
			{ userId: account.userId, aaguids: [`{${ALLOWED}}`] },
			{ userId: account.userId, aaguids: [ALLOWED], allowNoUsableSignInMethod: "yes" },
			{ userId: "not-a-uuid", aaguids: [ALLOWED] },
			{ userId: crypto.randomUUID(), aaguids: [ALLOWED] },
		];
		for (const input of malformed) {
			expect(
				await codeOf(
					bench.auth.user.limitAuthenticators(
						input as Parameters<typeof bench.auth.user.limitAuthenticators>[0],
					),
				),
			).toBe("invalid_input");
		}
		await bench.auth.user.limitAuthenticators({
			userId: account.userId,
			aaguids: [ALLOWED.toUpperCase(), ALLOWED, OTHER],
		});
		const sealed = await bench.auth.maintenance.resealSecurityState({
			userId: account.userId,
			reason: "read back",
		});
		expect(sealed.authenticatorAllowlist).toStrictEqual([ALLOWED, OTHER].sort());
	});

	it("lifts a list on an instance whose roots were taken away", async () => {
		const account = await signUp(off);
		expect(
			await codeOf(
				off.auth.user.limitAuthenticators({ userId: account.userId, aaguids: [ALLOWED] }),
			),
		).toBe("invalid_input");
		await expect(
			off.auth.user.liftAuthenticatorLimit({ userId: account.userId }),
		).resolves.toBeUndefined();
	});
});
