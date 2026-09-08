import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/core/db/actor.js";
import { registrationResponse } from "../src/core/factor/webauthn/payload.js";
import { VelveError } from "../src/core/http/error-map.js";
import {
	createAccount,
	enrol,
	newAuthenticator,
	ORIGIN,
	openWebAuthnFixture,
	RELYING_PARTY_ID,
	TEST_WEBAUTHN_CONFIG,
	type WebAuthnFixture,
} from "./webauthn-fixtures.js";
import { createVirtualAuthenticator } from "./webauthn-simulator.js";

describe("registering an authenticator", () => {
	let fixture: WebAuthnFixture;
	let actor: Actor;

	beforeAll(async () => {
		fixture = await openWebAuthnFixture("webauthn_registration");
		actor = await createAccount(fixture);
	});

	afterAll(() => fixture.close());

	it("asks for the relying party, the account and a five-minute deadline", async () => {
		const started = await fixture.service.register.start({ actor, userName: "someone" });

		expect(started.publicKeyOptions.rp).toEqual({
			id: RELYING_PARTY_ID,
			name: TEST_WEBAUTHN_CONFIG.relyingPartyName,
		});
		expect(started.publicKeyOptions.challenge).toBe(started.challengeToken);
		expect(started.publicKeyOptions.timeout).toBe(5 * 60 * 1000);
		expect(started.publicKeyOptions.authenticatorSelection?.userVerification).toBe("required");
		// Architecture 1 D37: a fixed default, not an option, and not "preferred".
		expect(started.publicKeyOptions.authenticatorSelection?.residentKey).toBe("required");
	});

	it("names the account's enrolled authenticators so the same one cannot be added twice", async () => {
		const other = await createAccount(fixture);
		const { authenticator } = await enrol(fixture, other, "first");

		const started = await fixture.service.register.start({ actor: other, userName: "someone" });

		expect(started.publicKeyOptions.excludeCredentials).toEqual([
			{ id: authenticator.credentialId, transports: ["internal"], type: "public-key" },
		]);
	});

	it("stores the label, the transports and the backup flags of a synchronised passkey", async () => {
		const account = await createAccount(fixture);
		const device = await newAuthenticator({
			backupEligible: true,
			backupState: true,
			transports: ["hybrid", "internal"],
		});

		const started = await fixture.service.register.start({ actor: account, userName: "someone" });
		const { credential } = await fixture.service.register.finish({
			actor: account,
			challengeToken: started.challengeToken,
			response: await device.attest({ challenge: started.challengeToken }),
			label: "Phone",
		});

		expect(credential.label).toBe("Phone");
		expect(credential.transports).toEqual(["hybrid", "internal"]);
		expect(credential.isBackupEligible).toBe(true);
		expect(credential.isCurrentlyBackedUp).toBe(true);
		expect(credential.wasUserVerifiedAtRegistration).toBe(true);
	});

	/** Architecture 3.6: `BE = false` is what device-bound means, and a security key is the case
	 * that produces it. The library stores the two flags and enforces no policy on them. */
	it("stores a security key as device-bound", async () => {
		const account = await createAccount(fixture);
		const key = await newAuthenticator({
			backupEligible: false,
			backupState: false,
			transports: ["usb", "nfc"],
		});

		const started = await fixture.service.register.start({ actor: account, userName: "someone" });
		const { credential } = await fixture.service.register.finish({
			actor: account,
			challengeToken: started.challengeToken,
			response: await key.attest({ challenge: started.challengeToken }),
			label: "Security key",
		});

		expect(credential.isBackupEligible).toBe(false);
		expect(credential.isCurrentlyBackedUp).toBe(false);
	});

	it("records an authenticator that declines to name its model as no model at all", async () => {
		const account = await createAccount(fixture);
		const { credentialId } = await enrol(fixture, account, "unnamed");

		const [listed] = await fixture.service.list({ actor: account });

		expect(listed?.id).toBe(credentialId);
		expect(listed?.aaguid).toBeNull();
	});

	it("records the model an authenticator does name", async () => {
		const account = await createAccount(fixture);
		const device = await createVirtualAuthenticator({
			relyingPartyId: RELYING_PARTY_ID,
			origin: ORIGIN,
			aaguid: Uint8Array.from([
				0xad, 0xce, 0x00, 0x02, 0x35, 0xbc, 0xc6, 0x0a, 0x64, 0x8b, 0x0b, 0x25, 0xf1, 0xf0, 0x55,
				0x03,
			]),
		});

		await enrol(fixture, account, "keyed", device);
		const [listed] = await fixture.service.list({ actor: account });

		expect(listed?.aaguid).toBe("adce0002-35bc-c60a-648b-0b25f1f05503");
	});

	it("rejects an attestation that was made for another origin", async () => {
		const account = await createAccount(fixture);
		const device = await newAuthenticator();
		const started = await fixture.service.register.start({ actor: account, userName: "someone" });

		const rejected = fixture.service.register.finish({
			actor: account,
			challengeToken: started.challengeToken,
			response: await device.attest({
				challenge: started.challengeToken,
				origin: "https://phishing.example",
			}),
			label: "Elsewhere",
		});

		await expect(rejected).rejects.toMatchObject({ reason: "origin_mismatch" });
	});

	it("rejects an attestation that was made for another relying party", async () => {
		const account = await createAccount(fixture);
		const device = await newAuthenticator();
		const started = await fixture.service.register.start({ actor: account, userName: "someone" });

		const rejected = fixture.service.register.finish({
			actor: account,
			challengeToken: started.challengeToken,
			response: await device.attest({
				challenge: started.challengeToken,
				relyingPartyId: "phishing.example",
			}),
			label: "Elsewhere",
		});

		await expect(rejected).rejects.toMatchObject({ reason: "signature_invalid" });
	});

	/** 3.15 A.8: `"discouraged"` is absent from the configuration, so a registration where the
	 * authenticator did not verify the user is refused under the default. */
	it("refuses an authenticator that did not verify the user", async () => {
		const account = await createAccount(fixture);
		const device = await newAuthenticator();
		const started = await fixture.service.register.start({ actor: account, userName: "someone" });

		const rejected = fixture.service.register.finish({
			actor: account,
			challengeToken: started.challengeToken,
			response: await device.attest({
				challenge: started.challengeToken,
				flags: { userVerified: false },
			}),
			label: "Unverified",
		});

		await expect(rejected).rejects.toMatchObject({ reason: "signature_invalid" });
	});

	it("accepts an unverified authenticator where the configuration only prefers verification", async () => {
		const preferring = await openWebAuthnFixture("webauthn_registration_preferred", {
			...TEST_WEBAUTHN_CONFIG,
			userVerification: "preferred",
		});
		try {
			const account = await createAccount(preferring);
			const device = await newAuthenticator();
			const started = await preferring.service.register.start({
				actor: account,
				userName: "someone",
			});

			const { credential } = await preferring.service.register.finish({
				actor: account,
				challengeToken: started.challengeToken,
				response: await device.attest({
					challenge: started.challengeToken,
					flags: { userVerified: false },
				}),
				label: "Unverified",
			});

			expect(credential.wasUserVerifiedAtRegistration).toBe(false);
		} finally {
			await preferring.close();
		}
	});

	it("refuses the same authenticator a second time", async () => {
		const account = await createAccount(fixture);
		const { authenticator } = await enrol(fixture, account, "once");
		const started = await fixture.service.register.start({ actor: account, userName: "someone" });

		const rejected = fixture.service.register.finish({
			actor: account,
			challengeToken: started.challengeToken,
			response: await authenticator.attest({ challenge: started.challengeToken }),
			label: "twice",
		});

		await expect(rejected).rejects.toThrow(VelveError);
		await expect(rejected).rejects.toMatchObject({ code: "webauthn_credential_rejected" });
	});
});

/**
 * The one seam nothing else crosses: the fixtures hand the simulator's raw object to the service,
 * and the routes that would parse first are undeclared (E-472). So this case parses the way the
 * route will and then reads the column, because that is where the value ends up (E-481).
 */
describe("a polluted prototype on the way to the column", () => {
	let fixture: WebAuthnFixture;

	beforeAll(async () => {
		fixture = await openWebAuthnFixture("webauthn_pollution");
	});

	afterAll(() => fixture.close());

	it("stores no transport the browser did not send", async () => {
		const account = await createAccount(fixture);
		const device = await newAuthenticator();
		const started = await fixture.service.register.start({ actor: account, userName: "someone" });
		const attested = await device.attest({ challenge: started.challengeToken });
		const withoutTransports = { ...attested, response: { ...attested.response } };
		Reflect.deleteProperty(withoutTransports.response, "transports");

		Object.defineProperty(Object.prototype, "transports", {
			value: ["usb", "POLLUTED"],
			configurable: true,
			enumerable: false,
			writable: true,
		});
		let stored: readonly string[];
		try {
			const parsed = registrationResponse().parse(JSON.parse(JSON.stringify(withoutTransports)));
			const { credential } = await fixture.service.register.finish({
				actor: account,
				challengeToken: started.challengeToken,
				response: parsed,
				label: "clean",
			});
			stored = credential.transports;
		} finally {
			Reflect.deleteProperty(Object.prototype, "transports");
		}

		expect(stored).toEqual([]);
		const [row] = await fixture.connection.query<{ transports: string | null }>(
			`SELECT to_jsonb(coalesce(transports, '{}'))::text AS transports
			 FROM ${fixture.schema}.webauthn_credential WHERE user_id = $1`,
			[account],
		);
		expect(row?.transports).toBe("[]");
	});
});
