import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/core/db/actor.js";
import { PENDING_CALLER_ROUTES } from "../src/core/factor/pending/index.js";
import { toVisibleFailure } from "../src/core/http/error-map.js";
import {
	beginSecondFactor,
	createAccount,
	enrol,
	newAuthenticator,
	openWebAuthnFixture,
	RELYING_PARTY_ID,
	type WebAuthnFixture,
} from "./webauthn-fixtures.js";
import type { SignatureFault, VirtualAuthenticator } from "./webauthn-simulator.js";

async function backupFlagsOf(
	fixture: WebAuthnFixture,
	actor: Actor,
): Promise<{ eligible: boolean; state: boolean; signCount: number; used: Date | null }> {
	const [row] = await fixture.connection.query<{
		backup_eligible: boolean;
		backup_state: boolean;
		sign_count: unknown;
		last_used_at: Date | null;
	}>(
		`SELECT backup_eligible, backup_state, sign_count, last_used_at
		 FROM ${fixture.schema}.webauthn_credential WHERE user_id = $1`,
		[actor],
	);
	return {
		eligible: row?.backup_eligible ?? false,
		state: row?.backup_state ?? false,
		signCount: Number(row?.sign_count ?? -1),
		used: row?.last_used_at ?? null,
	};
}

describe("signing in with a passkey", () => {
	let fixture: WebAuthnFixture;

	beforeAll(async () => {
		fixture = await openWebAuthnFixture("webauthn_passkey");
	});

	afterAll(() => fixture.close());

	/** Architecture 3.6: a full sign-in path of its own, so the ceremony names no credential and
	 * the authenticator chooses. */
	it("asks for no particular credential and demands user verification", async () => {
		const started = await fixture.service.passkey.start();

		expect(started.publicKeyOptions.allowCredentials).toBeUndefined();
		expect(started.publicKeyOptions.userVerification).toBe("required");
		expect(started.publicKeyOptions.rpId).toBe(RELYING_PARTY_ID);
		expect(started.publicKeyOptions.challenge).toBe(started.challengeToken);
	});

	it("names the account the discoverable credential belongs to", async () => {
		const account = await createAccount(fixture);
		const { authenticator } = await enrol(fixture, account, "phone");

		const started = await fixture.service.passkey.start();
		const verified = await fixture.service.passkey.finish({
			challengeToken: started.challengeToken,
			response: await authenticator.assert({ challenge: started.challengeToken }),
		});

		expect(verified.userId).toBe(account);
		expect(verified.credential.label).toBe("phone");
		expect(verified.signCountRegressed).toBe(false);
	});

	it("refuses an assertion from an authenticator nobody registered", async () => {
		const stranger = await newAuthenticator();
		const started = await fixture.service.passkey.start();

		const refused = fixture.service.passkey.finish({
			challengeToken: started.challengeToken,
			response: await stranger.assert({ challenge: started.challengeToken }),
		});

		await expect(refused).rejects.toMatchObject({ reason: "credential_unknown" });
	});

	it("refuses an assertion the authenticator did not verify the user for", async () => {
		const account = await createAccount(fixture);
		const { authenticator } = await enrol(fixture, account, "phone");
		const started = await fixture.service.passkey.start();

		const refused = fixture.service.passkey.finish({
			challengeToken: started.challengeToken,
			response: await authenticator.assert({
				challenge: started.challengeToken,
				flags: { userVerified: false },
			}),
		});

		await expect(refused).rejects.toMatchObject({ reason: "user_not_verified" });
	});

	it("refuses an assertion made for another origin and one made for another relying party", async () => {
		const account = await createAccount(fixture);
		const { authenticator } = await enrol(fixture, account, "phone");

		const forElsewhere = await fixture.service.passkey.start();
		const wrongOrigin = fixture.service.passkey.finish({
			challengeToken: forElsewhere.challengeToken,
			response: await authenticator.assert({
				challenge: forElsewhere.challengeToken,
				origin: "https://phishing.example",
			}),
		});
		await expect(wrongOrigin).rejects.toMatchObject({ reason: "origin_mismatch" });

		const forAnother = await fixture.service.passkey.start();
		const wrongRelyingParty = fixture.service.passkey.finish({
			challengeToken: forAnother.challengeToken,
			response: await authenticator.assert({
				challenge: forAnother.challengeToken,
				relyingPartyId: "phishing.example",
			}),
		});
		await expect(wrongRelyingParty).rejects.toMatchObject({ reason: "rp_id_mismatch" });
	});

	const FAULTS: readonly SignatureFault[] = [
		"another-key",
		"corrupted-signature",
		"empty-signature",
		"signed-without-the-client-data",
	];

	it.each(FAULTS)("refuses an assertion signed wrongly: %s", async (signatureFault) => {
		const account = await createAccount(fixture);
		const { authenticator } = await enrol(fixture, account, "phone");
		const started = await fixture.service.passkey.start();

		const refused = fixture.service.passkey.finish({
			challengeToken: started.challengeToken,
			response: await authenticator.assert({
				challenge: started.challengeToken,
				signatureFault,
			}),
		});

		await expect(refused).rejects.toSatisfy(
			(failure: unknown) => toVisibleFailure(failure).error.code === "webauthn_credential_rejected",
		);
	});
});

describe("completing a second factor with webauthn", () => {
	let fixture: WebAuthnFixture;

	beforeAll(async () => {
		fixture = await openWebAuthnFixture("webauthn_second_factor");
	});

	afterAll(() => fixture.close());

	/**
	 * S-CACHE-4 and 3.6: exactly four routes read `__Host-velve_pending`, and two of them are
	 * this feature's. The count is read from the list `pending` publishes rather than repeated
	 * here, so a third webauthn operation taking the intermediate state fails on the branch that
	 * adds it.
	 */
	it("takes the intermediate state in exactly the two operations the pending module names", () => {
		const mine = PENDING_CALLER_ROUTES.filter((route) => route.startsWith("factor.webauthn."));

		expect(mine).toEqual([
			"factor.webauthn.authenticate.start",
			"factor.webauthn.authenticate.finish",
		]);
		expect(Object.keys(fixture.service.authenticate).sort()).toEqual(
			mine.map((route) => route.split(".").at(-1)).sort(),
		);
	});

	it("names the account's credentials and demands user verification", async () => {
		const account = await createAccount(fixture);
		const { authenticator } = await enrol(fixture, account, "key");

		const started = await fixture.service.authenticate.start({
			pending: await beginSecondFactor(fixture, account),
		});

		expect(started.publicKeyOptions.allowCredentials).toEqual([
			{ id: authenticator.credentialId, transports: ["internal"], type: "public-key" },
		]);
		expect(started.publicKeyOptions.userVerification).toBe("required");
	});

	it("says the factor is not enrolled when the account has no authenticator", async () => {
		const account = await createAccount(fixture);

		const refused = fixture.service.authenticate.start({
			pending: await beginSecondFactor(fixture, account),
		});

		await expect(refused).rejects.toMatchObject({ code: "factor_not_enrolled" });
	});

	it("completes for the account the credential belongs to", async () => {
		const account = await createAccount(fixture);
		const { authenticator } = await enrol(fixture, account, "key");

		const pending = await beginSecondFactor(fixture, account);
		const started = await fixture.service.authenticate.start({ pending });
		const verified = await fixture.service.authenticate.finish({
			pending,
			challengeToken: started.challengeToken,
			response: await authenticator.assert({ challenge: started.challengeToken }),
		});

		expect(verified.userId).toBe(account);
	});

	it("refuses another account's authenticator", async () => {
		const a = await createAccount(fixture);
		const b = await createAccount(fixture);
		const stolen = await enrol(fixture, a, "a-key");
		await enrol(fixture, b, "b-key");

		const pending = await beginSecondFactor(fixture, b);
		const started = await fixture.service.authenticate.start({ pending });
		const refused = fixture.service.authenticate.finish({
			pending,
			challengeToken: started.challengeToken,
			response: await stolen.authenticator.assert({ challenge: started.challengeToken }),
		});

		await expect(refused).rejects.toMatchObject({ reason: "credential_unknown" });
	});

	it("refuses a challenge that was issued for another account", async () => {
		const a = await createAccount(fixture);
		const b = await createAccount(fixture);
		const own = await enrol(fixture, a, "a-key");
		await enrol(fixture, b, "b-key");

		const forB = await fixture.service.authenticate.start({
			pending: await beginSecondFactor(fixture, b),
		});
		const refused = fixture.service.authenticate.finish({
			pending: await beginSecondFactor(fixture, a),
			challengeToken: forB.challengeToken,
			response: await own.authenticator.assert({ challenge: forB.challengeToken }),
		});

		await expect(refused).rejects.toMatchObject({ reason: "challenge_not_found" });
	});
});

describe("the sign counter and the backup flags", () => {
	let fixture: WebAuthnFixture;

	beforeAll(async () => {
		fixture = await openWebAuthnFixture("webauthn_counter");
	});

	afterAll(() => fixture.close());

	async function signInWith(
		account: Actor,
		authenticator: VirtualAuthenticator,
		overrides: { signCount?: number; backupState?: boolean; backupEligible?: boolean } = {},
	) {
		const pending = await beginSecondFactor(fixture, account);
		const started = await fixture.service.authenticate.start({ pending });
		return fixture.service.authenticate.finish({
			pending,
			challengeToken: started.challengeToken,
			response: await authenticator.assert({
				challenge: started.challengeToken,
				...(overrides.signCount === undefined ? {} : { signCount: overrides.signCount }),
				flags: {
					...(overrides.backupState === undefined ? {} : { backupState: overrides.backupState }),
					...(overrides.backupEligible === undefined
						? {}
						: { backupEligible: overrides.backupEligible }),
				},
			}),
		});
	}

	it("carries the counter forward while it rises", async () => {
		const account = await createAccount(fixture);
		const { authenticator } = await enrol(fixture, account, "key");

		await signInWith(account, authenticator, { signCount: 7 });
		const second = await signInWith(account, authenticator, { signCount: 9 });

		expect(second.signCountRegressed).toBe(false);
		expect((await backupFlagsOf(fixture, account)).signCount).toBe(9);
	});

	/**
	 * L-9. This has no `S-` number and no `T-` case; it is tested anyway, because it is the
	 * documented deviation from WebAuthn Level 3 §7.2 and the only way anyone learns it is a
	 * field of the sign-in result rather than a refusal.
	 */
	it("reports a counter that has fallen back, and signs the caller in anyway", async () => {
		const account = await createAccount(fixture);
		const { authenticator } = await enrol(fixture, account, "cloned");

		await signInWith(account, authenticator, { signCount: 40 });
		const regressed = await signInWith(account, authenticator, { signCount: 12 });

		expect(regressed.signCountRegressed).toBe(true);
		expect(regressed.userId).toBe(account);
	});

	it("reports a counter that has stood still, because a counter in use has to rise", async () => {
		const account = await createAccount(fixture);
		const { authenticator } = await enrol(fixture, account, "stuck");

		await signInWith(account, authenticator, { signCount: 5 });
		const repeated = await signInWith(account, authenticator, { signCount: 5 });

		expect(repeated.signCountRegressed).toBe(true);
	});

	/** An authenticator that keeps no counter reports zero on every assertion, and that is not a
	 * regression — it is the absence of a counter. */
	it("reports nothing for an authenticator that keeps no counter", async () => {
		const account = await createAccount(fixture);
		const authenticator = await newAuthenticator();
		const registration = await fixture.service.register.start({ actor: account, userName: "a" });
		await fixture.service.register.finish({
			actor: account,
			challengeToken: registration.challengeToken,
			response: await authenticator.attest({
				challenge: registration.challengeToken,
				signCount: 0,
			}),
			label: "counterless",
		});

		const first = await signInWith(account, authenticator, { signCount: 0 });
		const second = await signInWith(account, authenticator, { signCount: 0 });

		expect(first.signCountRegressed).toBe(false);
		expect(second.signCountRegressed).toBe(false);
	});

	it("takes the reported counter rather than keeping the higher one, so the report is made once", async () => {
		const account = await createAccount(fixture);
		const { authenticator } = await enrol(fixture, account, "reset");

		await signInWith(account, authenticator, { signCount: 30 });
		const fallen = await signInWith(account, authenticator, { signCount: 2 });
		const afterwards = await signInWith(account, authenticator, { signCount: 3 });

		expect(fallen.signCountRegressed).toBe(true);
		expect(afterwards.signCountRegressed).toBe(false);
		expect((await backupFlagsOf(fixture, account)).signCount).toBe(3);
	});

	/** Architecture 3.6: BE and BS are stored beside the authenticator data and written on every
	 * sign-in, so a passkey the user has since synchronised stops reading as device-bound. */
	it("writes the backup flags again on every sign-in", async () => {
		const account = await createAccount(fixture);
		const device = await newAuthenticator({ backupEligible: true, backupState: false });
		const { authenticator } = await enrol(fixture, account, "phone", device);

		const atRegistration = await backupFlagsOf(fixture, account);
		await signInWith(account, authenticator, { backupEligible: true, backupState: true });
		const afterSynchronising = await backupFlagsOf(fixture, account);

		expect(atRegistration).toMatchObject({ eligible: true, state: false });
		expect(afterSynchronising).toMatchObject({ eligible: true, state: true });
	});

	it("records when a credential was last used, and leaves it unset until then", async () => {
		const account = await createAccount(fixture);
		const { authenticator } = await enrol(fixture, account, "key");

		expect((await backupFlagsOf(fixture, account)).used).toBeNull();
		await signInWith(account, authenticator);

		expect((await backupFlagsOf(fixture, account)).used).toBeInstanceOf(Date);
	});
});
