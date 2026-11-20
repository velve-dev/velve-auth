import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { decodeAttestationObject } from "@simplewebauthn/server/helpers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "../src/core/db/actor.js";
import type { Driver } from "../src/core/db/driver.js";
import {
	createWebAuthnService,
	type WebAuthnService,
} from "../src/core/factor/webauthn/service.js";
import { ConcealedError, toVisibleFailure } from "../src/core/http/error-map.js";
import { testKeyProvider } from "./auth-fixtures.js";
import { actorOfTestUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { testSecurityState } from "./security-state-fixtures.js";
import {
	createAttestingAuthenticator,
	createTestCertificateAuthority,
	type TestCertificateAuthority,
} from "./verified-attestation-fixtures.js";
import { ORIGIN, RELYING_PARTY_ID, TEST_WEBAUTHN_CONFIG } from "./webauthn-fixtures.js";

/**
 * S-INTEG-13 and E-3854: whatever format a client claims, a certificate it sends that names a
 * revocation list is refused before `@simplewebauthn/server` sees it, so no registration makes the
 * server reach a host the client chose. Each format whose verifier validates a chain is claimed in
 * turn — `x5c` in the statement, and the chain in the JWS header of `android-safetynet` — with and
 * without `webauthn.attestation`; the same chain without a distribution point is not refused here.
 */

const AAGUID = "2fc0579f-8113-47ea-b116-bb5a8db9202a";
const LIST_URL = "http://192.0.2.1/claimed.crl";

let authority: TestCertificateAuthority;
let connection: TestConnection;
let schema: string;
let configured: WebAuthnService;
let unconfigured: WebAuthnService;

beforeAll(async () => {
	authority = await createTestCertificateAuthority();
	({ connection, schema } = await openMigratedSchema("attest_egress"));
	const keys = testKeyProvider();
	const securityState = testSecurityState(connection, schema, keys);
	const serviceWith = (attestation: boolean) =>
		createWebAuthnService({
			driver: connection as Driver,
			schema,
			keys,
			webauthn: {
				...TEST_WEBAUTHN_CONFIG,
				...(attestation ? { attestation: { trustedRoots: [authority.rootPem] } } : {}),
			},
			securityState,
		});
	configured = serviceWith(true);
	unconfigured = serviceWith(false);
}, 60_000);

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

function head(major: number, value: number): Uint8Array {
	if (value < 24) {
		return Uint8Array.of((major << 5) | value);
	}
	if (value < 0x100) {
		return Uint8Array.of((major << 5) | 24, value);
	}
	return Uint8Array.of((major << 5) | 25, value >> 8, value & 0xff);
}

const text = (value: string) => {
	const bytes = new TextEncoder().encode(value);
	return Buffer.concat([head(3, bytes.length), bytes]);
};
const bytes = (value: Uint8Array) => Buffer.concat([head(2, value.length), value]);

/** the attestation object a client would send for the format, carrying the chain where that format does */
function attestationObjectOf(
	format: string,
	authData: Uint8Array,
	chain: readonly Uint8Array[],
): string {
	const x5c = Buffer.concat([
		head(4, chain.length),
		...chain.map((certificate) => bytes(certificate)),
	]);
	const statement =
		format === "android-safetynet"
			? Buffer.concat([
					head(5, 2),
					text("ver"),
					text("1"),
					text("response"),
					bytes(
						new TextEncoder().encode(
							`${Buffer.from(
								JSON.stringify({
									alg: "RS256",
									x5c: chain.map((certificate) => Buffer.from(certificate).toString("base64")),
								}),
							).toString("base64url")}.e30.c2ln`,
						),
					),
				])
			: Buffer.concat([head(5, 2), text("alg"), Uint8Array.of(0x26), text("x5c"), x5c]);
	return Buffer.concat([
		head(5, 3),
		text("fmt"),
		text(format),
		text("attStmt"),
		statement,
		text("authData"),
		bytes(authData),
	]).toString("base64url");
}

async function registrationClaiming(
	service: WebAuthnService,
	actor: Actor,
	format: string,
	revocationListUrl: string | undefined,
): Promise<unknown> {
	const identity = await authority.issue({
		aaguid: AAGUID,
		...(revocationListUrl === undefined ? {} : { revocationListUrl }),
	});
	const authenticator = await createAttestingAuthenticator({
		relyingPartyId: RELYING_PARTY_ID,
		origin: ORIGIN,
		aaguid: AAGUID,
		attestation: { kind: "none" },
	});
	const started = await service.register.start({ actor, userName: "someone" });
	const honest = await authenticator.attest({ challenge: started.challengeToken });
	const authData = decodeAttestationObject(
		Uint8Array.from(Buffer.from(honest.response.attestationObject, "base64url")),
	).get("authData");
	const claimed: RegistrationResponseJSON = {
		...honest,
		response: {
			...honest.response,
			attestationObject: attestationObjectOf(format, authData, identity.chain),
		},
	};
	try {
		await service.register.finish({
			actor,
			challengeToken: started.challengeToken,
			response: claimed,
			label: "key",
		});
		return "resolved";
	} catch (cause) {
		return {
			reason: cause instanceof ConcealedError ? cause.reason : "other",
			visible: toVisibleFailure(cause).error.code,
		};
	}
}

async function createAccount(): Promise<Actor> {
	const [row] = await connection.query<{ id: string }>(
		`INSERT INTO ${schema}.user (email) VALUES ($1) RETURNING id`,
		[`${crypto.randomUUID()}@example.com`],
	);
	if (row === undefined) {
		throw new Error("the account was not created");
	}
	return actorOfTestUser(row.id);
}

const FORMATS = ["packed", "fido-u2f", "android-key", "apple", "tpm", "android-safetynet"] as const;

describe("no format reaches the network (S-INTEG-13, E-3854)", () => {
	for (const [where, service] of [
		["with roots configured", () => configured],
		["without webauthn.attestation", () => unconfigured],
	] as const) {
		for (const format of FORMATS) {
			it(`refuses ${format} with a chain naming a revocation list before verifying it, ${where}`, async () => {
				const fetched = vi
					.spyOn(globalThis, "fetch")
					.mockImplementation(() => Promise.reject(new Error("no network in a test")));
				try {
					const outcome = await registrationClaiming(
						service(),
						await createAccount(),
						format,
						LIST_URL,
					);
					expect(outcome).toEqual({
						reason: "attestation_names_a_revocation_list",
						visible: "webauthn_credential_rejected",
					});
					expect(fetched).not.toHaveBeenCalled();
				} finally {
					fetched.mockRestore();
				}
			});
		}
	}

	it("lets the same chain without a distribution point through to the format's own verifier", async () => {
		const fetched = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(() => Promise.reject(new Error("no network in a test")));
		try {
			for (const format of FORMATS) {
				const outcome = await registrationClaiming(
					configured,
					await createAccount(),
					format,
					undefined,
				);
				expect(outcome, format).not.toMatchObject({
					reason: "attestation_names_a_revocation_list",
				});
				expect(outcome, format).not.toMatchObject({ reason: "attestation_unreadable" });
			}
			expect(fetched).not.toHaveBeenCalled();
		} finally {
			fetched.mockRestore();
		}
	});
});
