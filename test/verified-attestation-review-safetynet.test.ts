import { createHash, randomBytes } from "node:crypto";
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
import { decodeBase64Url } from "../src/core/keys/base64url.js";
import { testKeyProvider } from "./auth-fixtures.js";
import { actorOfTestUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { testSecurityState } from "./security-state-fixtures.js";
import { createAttestingAuthenticator } from "./verified-attestation-fixtures.js";
import { ORIGIN, RELYING_PARTY_ID, TEST_WEBAUTHN_CONFIG } from "./webauthn-fixtures.js";

/**
 * Reviewer's second-round case for E-3854: an android-safetynet statement complete enough to
 * reach the dependency's chain validation, whose JWS header carries a certificate naming a
 * revocation list. The header is spelled in standard base64 rather than base64url, which the
 * dependency's lenient decoder reads and the library's strict one does not; the pre-check must
 * then refuse rather than read the header as carrying no chain.
 */

const AAGUID = "2fc0579f-8113-47ea-b116-bb5a8db9202a";
const LIST_URL = "http://203.0.113.9/header-chain.crl";

let connection: TestConnection;
let schema: string;
let service: WebAuthnService;

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("attest_review_safetynet"));
	const keys = testKeyProvider();
	service = createWebAuthnService({
		driver: connection as Driver,
		schema,
		keys,
		webauthn: TEST_WEBAUTHN_CONFIG,
		securityState: testSecurityState(connection, schema, keys),
	});
}, 60_000);

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

function der(tag: number, ...content: readonly Uint8Array[]): Uint8Array {
	const body = Buffer.concat(content);
	const length =
		body.length < 0x80
			? Uint8Array.of(body.length)
			: body.length < 0x100
				? Uint8Array.of(0x81, body.length)
				: Uint8Array.of(0x82, body.length >> 8, body.length & 0xff);
	return Buffer.concat([Uint8Array.of(tag), length, body]);
}

function oid(dotted: string): Uint8Array {
	const arcs = dotted.split(".").map(Number);
	const encoded = [40 * (arcs[0] ?? 0) + (arcs[1] ?? 0)];
	for (const arc of arcs.slice(2)) {
		const digits = [arc & 0x7f];
		for (let rest = arc >> 7; rest > 0; rest >>= 7) {
			digits.unshift((rest & 0x7f) | 0x80);
		}
		encoded.push(...digits);
	}
	return der(0x06, Uint8Array.from(encoded));
}

function utcTime(date: Date): Uint8Array {
	const spelled = date.toISOString().replace(/[-:T]/g, "").slice(2, 14);
	return der(0x17, new TextEncoder().encode(`${spelled}Z`));
}

async function certificateForAttestAndroidCom(revocationListUrl: string): Promise<Uint8Array> {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	]);
	if (!("publicKey" in pair)) {
		throw new Error("the runtime returned a single key where a P-256 pair was asked for");
	}
	const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
	const name = der(
		0x30,
		der(0x31, der(0x30, oid("2.5.4.3"), der(0x0c, new TextEncoder().encode("attest.android.com")))),
	);
	const algorithm = der(0x30, oid("1.2.840.10045.4.3.2"));
	const distributionPoint = der(
		0x30,
		oid("2.5.29.31"),
		der(
			0x04,
			der(
				0x30,
				der(0x30, der(0xa0, der(0xa0, der(0x86, new TextEncoder().encode(revocationListUrl))))),
			),
		),
	);
	const now = Date.now();
	const tbs = der(
		0x30,
		der(0xa0, der(0x02, Uint8Array.of(2))),
		der(0x02, Uint8Array.of(0x01, ...randomBytes(8))),
		algorithm,
		name,
		der(0x30, utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 86_400_000))),
		name,
		spki,
		der(0xa3, der(0x30, distributionPoint)),
	);
	const signature = der(
		0x30,
		der(0x02, Uint8Array.of(0x01, ...randomBytes(31))),
		der(0x02, Uint8Array.of(0x01, ...randomBytes(31))),
	);
	return der(0x30, tbs, algorithm, der(0x03, Uint8Array.of(0), signature));
}

function cborHead(major: number, value: number): Uint8Array {
	if (value < 24) {
		return Uint8Array.of((major << 5) | value);
	}
	if (value < 0x100) {
		return Uint8Array.of((major << 5) | 24, value);
	}
	return Uint8Array.of((major << 5) | 25, value >> 8, value & 0xff);
}

const cborText = (value: string) => {
	const bytes = new TextEncoder().encode(value);
	return Buffer.concat([cborHead(3, bytes.length), bytes]);
};
const cborBytes = (value: Uint8Array) => Buffer.concat([cborHead(2, value.length), value]);

function headerInStandardBase64(chain: readonly string[]): string {
	for (let filler = 0; filler < 64; filler += 1) {
		const json = JSON.stringify({ alg: "ES256", x5c: chain, kid: "~".repeat(filler) });
		const spelled = Buffer.from(json).toString("base64").replace(/=+$/, "");
		if (/[+/]/.test(spelled) && decodeBase64Url(spelled) === null) {
			return spelled;
		}
	}
	throw new Error("no filler gave a header the strict decoder refuses");
}

async function safetyNetRegistration(actor: Actor): Promise<{
	readonly challengeToken: string;
	readonly response: RegistrationResponseJSON;
}> {
	const authenticator = await createAttestingAuthenticator({
		relyingPartyId: RELYING_PARTY_ID,
		origin: ORIGIN,
		aaguid: AAGUID,
		attestation: { kind: "none" },
	});
	const started = await service.register.start({ actor, userName: "someone" });
	const honest = await authenticator.attest({ challenge: started.challengeToken });
	const authData: Uint8Array = decodeAttestationObject(
		Uint8Array.from(Buffer.from(honest.response.attestationObject, "base64url")),
	).get("authData");
	const clientDataHash = createHash("sha256")
		.update(Buffer.from(honest.response.clientDataJSON, "base64url"))
		.digest();
	const nonce = createHash("sha256")
		.update(Buffer.concat([authData, clientDataHash]))
		.digest("base64");
	const leaf = await certificateForAttestAndroidCom(LIST_URL);
	const header = headerInStandardBase64([Buffer.from(leaf).toString("base64")]);
	const payload = Buffer.from(
		JSON.stringify({ nonce, ctsProfileMatch: true, timestampMs: Date.now() - 1_000 }),
	).toString("base64url");
	const jws = `${header}.${payload}.c2ln`;
	const statement = Buffer.concat([
		cborHead(5, 2),
		cborText("ver"),
		cborText("1"),
		cborText("response"),
		cborBytes(new TextEncoder().encode(jws)),
	]);
	const attestationObject = Buffer.concat([
		cborHead(5, 3),
		cborText("fmt"),
		cborText("android-safetynet"),
		cborText("attStmt"),
		statement,
		cborText("authData"),
		cborBytes(authData),
	]).toString("base64url");
	return {
		challengeToken: started.challengeToken,
		response: { ...honest, response: { ...honest.response, attestationObject } },
	};
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

describe("a safetynet header the strict decoder refuses (E-3854)", () => {
	it("is refused before the verifier and makes no fetch", async () => {
		const fetched = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(() => Promise.reject(new Error("no network in a test")));
		try {
			const actor = await createAccount();
			const { challengeToken, response } = await safetyNetRegistration(actor);
			let outcome: unknown = "resolved";
			try {
				await service.register.finish({ actor, challengeToken, response, label: "key" });
			} catch (cause) {
				outcome = {
					reason: cause instanceof ConcealedError ? cause.reason : "other",
					visible: toVisibleFailure(cause).error.code,
				};
			}
			expect(fetched.mock.calls.map(([url]) => String(url))).toStrictEqual([]);
			expect(outcome).toEqual({
				reason: "attestation_unreadable",
				visible: "webauthn_credential_rejected",
			});
		} finally {
			fetched.mockRestore();
		}
	});
});
