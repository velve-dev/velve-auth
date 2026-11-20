import { describe, expect, it } from "vitest";
import {
	InvalidWebAuthnConfigError,
	type WebAuthnAttestationConfig,
	webAuthnSettingsOf,
} from "../src/core/factor/webauthn/config.js";
import { normalisedAllowlistOf } from "../src/core/security-state/authenticator-allowlist.js";
import { encodeSecurityState, FIRST_GENERATIONS } from "../src/core/security-state/encoding.js";
import { satisfiesTheAllowlist } from "../src/core/security-state/read.js";
import { createTestCertificateAuthority, pemOf } from "./verified-attestation-fixtures.js";
import { TEST_WEBAUTHN_CONFIG } from "./webauthn-fixtures.js";

/**
 * S-INTEG-13 and S-DEFAULT-8 at the start and in the encoding: the roots an instance takes, the
 * configurations it refuses to start with, the one spelling a list is kept in, the rule that an
 * unverified attestation never satisfies a list, and that an account without a list or an
 * attested passkey keeps the encoding, and so the seal, it had before migration 8.
 */

const ALLOWED = "2fc0579f-8113-47ea-b116-bb5a8db9202a";

function startWith(attestation: unknown) {
	return () =>
		webAuthnSettingsOf({
			...TEST_WEBAUTHN_CONFIG,
			attestation: attestation as WebAuthnAttestationConfig,
		});
}

function codeOf(start: () => unknown): string {
	try {
		start();
	} catch (cause) {
		if (cause instanceof InvalidWebAuthnConfigError) {
			return cause.code;
		}
		throw cause;
	}
	return "started";
}

describe("webauthn.attestation at the start (S-INTEG-13)", () => {
	it("is off while absent and takes a root as PEM text or DER bytes", async () => {
		expect(webAuthnSettingsOf(TEST_WEBAUTHN_CONFIG).attestation).toBeNull();
		const authority = await createTestCertificateAuthority();
		const settings = webAuthnSettingsOf({
			...TEST_WEBAUTHN_CONFIG,
			attestation: { trustedRoots: [authority.rootPem, authority.rootDer] },
		});
		expect(settings.attestation?.trustedRoots).toEqual([authority.rootPem, authority.rootPem]);
		expect(settings.attestation?.requestForEveryAccount).toBe(false);
	});

	it("refuses to start with roots nobody can verify against or a switch that is no boolean", async () => {
		const authority = await createTestCertificateAuthority();
		const listing = await createTestCertificateAuthority({
			revocationListUrl: "http://127.0.0.1:9/root.crl",
		});
		const cases: readonly (readonly [unknown, string])[] = [
			["roots", "attestation_not_an_object"],
			[null, "attestation_not_an_object"],
			[{}, "attestation_roots_empty"],
			[{ trustedRoots: [] }, "attestation_roots_empty"],
			[{ trustedRoots: ["not a certificate"] }, "attestation_root_unreadable"],
			[
				{ trustedRoots: [new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01])] },
				"attestation_root_unreadable",
			],
			[{ trustedRoots: [42] }, "attestation_root_unreadable"],
			[
				{ trustedRoots: [`${authority.rootPem}${authority.rootPem}`] },
				"attestation_root_unreadable",
			],
			[{ trustedRoots: [pemOf(listing.rootDer)] }, "attestation_root_names_a_revocation_list"],
			[
				{ trustedRoots: [authority.rootPem], requestForEveryAccount: "true" },
				"attestation_request_for_every_account_not_a_boolean",
			],
		];
		for (const [attestation, code] of cases) {
			expect(codeOf(startWith(attestation))).toBe(code);
		}
		expect(
			codeOf(startWith({ trustedRoots: [authority.rootPem], requestForEveryAccount: true })),
		).toBe("started");
	});
});

describe("the list and the attestation that satisfies it (S-INTEG-13)", () => {
	it("keeps a list in one lower-case, sorted spelling without repeats and refuses anything else", () => {
		const upper = "CB69481E-8FF7-4039-93EC-0A2729A154A8";
		expect(normalisedAllowlistOf([upper, ALLOWED, ALLOWED])).toEqual([
			ALLOWED,
			upper.toLowerCase(),
		]);
		for (const refused of [
			[],
			"x",
			[1],
			["00000000-0000-0000-0000-000000000000"],
			[`${ALLOWED} `],
		]) {
			expect(normalisedAllowlistOf(refused)).toBeNull();
		}
	});

	it("lets every passkey sign in without a list and only an attested one on the list with one", () => {
		expect(satisfiesTheAllowlist(null, null)).toBe(true);
		expect(satisfiesTheAllowlist([ALLOWED], ALLOWED)).toBe(true);
		expect(satisfiesTheAllowlist([ALLOWED], null)).toBe(false);
		expect(satisfiesTheAllowlist([ALLOWED], "cb69481e-8ff7-4039-93ec-0a2729a154a8")).toBe(false);
	});
});

describe("the seal over the list and the attestation (S-INTEG-2, S-INTEG-13)", () => {
	const state = {
		userId: "6f1c2a52-6bd4-4b6f-9d0e-3c8d1a2b3c4d",
		version: 3,
		sessionEpoch: 7,
		...FIRST_GENERATIONS,
		email: "someone@example.com",
		emailVerified: true,
		disabled: false,
		recoveryDisabled: false,
		password: null,
		passwordResetRequired: false,
		totp: null,
		passkeys: [{ credentialId: new Uint8Array([1, 2]), publicKey: new Uint8Array([3, 4]) }],
		identities: [],
		recoveryCodes: [],
		passkeyRecovery: null,
	};

	it("encodes an account without a list or an attested passkey exactly as before migration 8", () => {
		const before = encodeSecurityState(state);
		const after = encodeSecurityState({
			...state,
			passkeys: [{ ...state.passkeys[0], attestedAaguid: null } as (typeof state.passkeys)[0]],
			authenticatorAllowlist: null,
		});
		expect(Buffer.from(after).equals(Buffer.from(before))).toBe(true);
	});

	it("gives a list, an added aaguid and an attested passkey encodings of their own", () => {
		const encodings = [
			encodeSecurityState(state),
			encodeSecurityState({ ...state, authenticatorAllowlist: [ALLOWED] }),
			encodeSecurityState({
				...state,
				authenticatorAllowlist: [ALLOWED, "cb69481e-8ff7-4039-93ec-0a2729a154a8"],
			}),
			encodeSecurityState({
				...state,
				passkeys: [{ ...state.passkeys[0], attestedAaguid: ALLOWED } as (typeof state.passkeys)[0]],
			}),
			encodeSecurityState({
				...state,
				passkeys: [{ ...state.passkeys[0], attestedAaguid: ALLOWED } as (typeof state.passkeys)[0]],
				authenticatorAllowlist: [ALLOWED],
			}),
		].map((encoded) => Buffer.from(encoded).toString("hex"));
		expect(new Set(encodings).size).toBe(encodings.length);
	});
});
