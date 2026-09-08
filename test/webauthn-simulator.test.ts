import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { beforeAll, describe, expect, it } from "vitest";
import { encodeBase64Url } from "../src/core/keys/base64url.js";
import { createSecretToken } from "../src/core/token/index.js";
import { ORIGIN, RELYING_PARTY_ID } from "./webauthn-fixtures.js";
import {
	createVirtualAuthenticator,
	derSignatureOf,
	encodeCbor,
	type SignatureFault,
	type VirtualAuthenticator,
} from "./webauthn-simulator.js";

/**
 * The simulator is the instrument every other WebAuthn case is measured with, so it is checked
 * against `@simplewebauthn/server` directly and without the library in between. A simulator that
 * only ever agreed with Velve Auth would prove that the two share a mistake.
 */
describe("the virtual authenticator", () => {
	let authenticator: VirtualAuthenticator;

	beforeAll(async () => {
		authenticator = await createVirtualAuthenticator({
			relyingPartyId: RELYING_PARTY_ID,
			origin: ORIGIN,
		});
	});

	it("produces an attestation the verifier accepts", async () => {
		const challenge = createSecretToken();
		const response = await authenticator.attest({ challenge });

		const verification = await verifyRegistrationResponse({
			response,
			expectedChallenge: challenge,
			expectedOrigin: ORIGIN,
			expectedRPID: RELYING_PARTY_ID,
		});

		expect(verification.verified).toBe(true);
		expect(verification.registrationInfo?.credential.id).toBe(response.id);
	});

	it("produces an assertion the verifier accepts against the registered key", async () => {
		const registrationChallenge = createSecretToken();
		const registration = await authenticator.attest({ challenge: registrationChallenge });
		const registered = await verifyRegistrationResponse({
			response: registration,
			expectedChallenge: registrationChallenge,
			expectedOrigin: ORIGIN,
			expectedRPID: RELYING_PARTY_ID,
		});
		const credential = registered.registrationInfo?.credential;
		expect(credential).toBeDefined();

		const challenge = createSecretToken();
		const assertion = await authenticator.assert({ challenge });
		const verification = await verifyAuthenticationResponse({
			response: assertion,
			expectedChallenge: challenge,
			expectedOrigin: ORIGIN,
			expectedRPID: RELYING_PARTY_ID,
			credential: {
				id: credential?.id ?? "",
				publicKey: credential?.publicKey ?? new Uint8Array(),
				counter: 0,
			},
		});

		expect(verification.verified).toBe(true);
	});

	const FAULTS: readonly SignatureFault[] = [
		"another-key",
		"corrupted-signature",
		"empty-signature",
		"signed-without-the-client-data",
		"client-data-exchanged-after-signing",
	];

	it("can sign wrongly in five ways, and a shorter list would delete cases rather than fail them", () => {
		expect(FAULTS).toHaveLength(5);
		expect(new Set(FAULTS).size).toBe(5);
	});

	it.each(FAULTS)("signs wrongly on demand: %s", async (signatureFault) => {
		const registrationChallenge = createSecretToken();
		const registration = await authenticator.attest({ challenge: registrationChallenge });
		const registered = await verifyRegistrationResponse({
			response: registration,
			expectedChallenge: registrationChallenge,
			expectedOrigin: ORIGIN,
			expectedRPID: RELYING_PARTY_ID,
		});
		const credential = registered.registrationInfo?.credential;

		const challenge = createSecretToken();
		const assertion = await authenticator.assert({ challenge, signatureFault });
		const outcome = await verifyAuthenticationResponse({
			response: assertion,
			expectedChallenge: challenge,
			expectedOrigin: ORIGIN,
			expectedRPID: RELYING_PARTY_ID,
			credential: {
				id: credential?.id ?? "",
				publicKey: credential?.publicKey ?? new Uint8Array(),
				counter: 0,
			},
		}).catch(() => ({ verified: false }));

		expect(outcome.verified).toBe(false);
	});

	it("encodes a canonical map: shorter key first, then bytewise", () => {
		const encoded = encodeCbor({
			kind: "map",
			entries: [
				[
					{ kind: "text", value: "authData" },
					{ kind: "unsigned", value: 1 },
				],
				[
					{ kind: "text", value: "fmt" },
					{ kind: "unsigned", value: 2 },
				],
				[
					{ kind: "text", value: "attStmt" },
					{ kind: "unsigned", value: 3 },
				],
			],
		});

		expect(encodeBase64Url(encoded)).toBe(
			encodeBase64Url(
				new Uint8Array([
					0xa3, 0x63, 0x66, 0x6d, 0x74, 0x02, 0x67, 0x61, 0x74, 0x74, 0x53, 0x74, 0x6d, 0x74, 0x03,
					0x68, 0x61, 0x75, 0x74, 0x68, 0x44, 0x61, 0x74, 0x61, 0x01,
				]),
			),
		);
	});

	it("pads a DER integer whose high bit is set and trims a leading zero", () => {
		const raw = new Uint8Array(64);
		raw[0] = 0x80;
		raw[32] = 0x00;
		raw[33] = 0x01;

		const der = derSignatureOf(raw);

		expect(der[0]).toBe(0x30);
		expect(der[2]).toBe(0x02);
		expect(der[4]).toBe(0x00);
	});
});
