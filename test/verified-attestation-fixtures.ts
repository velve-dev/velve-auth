import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
	AuthenticationResponseJSON,
	AuthenticatorTransportFuture,
	RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { derSignatureOf, encodeCbor, type VirtualAuthenticator } from "./webauthn-simulator.js";

/**
 * Real attestation for the verified-attestation cases (3.18, S-INTEG-13): a test certificate
 * authority made in the test setup, attestation certificates it issues, and an authenticator that
 * answers a registration with a full packed attestation, a self attestation or none. Every private
 * key lives in memory for one run and is never written anywhere (CLAUDE.md §8). The certificates
 * are DER built here by hand, so the verifier under test and this builder share no code.
 */

const ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";
const COUNTRY = "2.5.4.6";
const ORGANISATION = "2.5.4.10";
const ORGANISATIONAL_UNIT = "2.5.4.11";
const COMMON_NAME = "2.5.4.3";
const BASIC_CONSTRAINTS = "2.5.29.19";
const KEY_USAGE = "2.5.29.15";
const CRL_DISTRIBUTION_POINTS = "2.5.29.31";
const FIDO_GEN_CE_AAGUID = "1.3.6.1.4.1.45724.1.1.4";

const DAY_IN_MS = 24 * 60 * 60 * 1000;

function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
	const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.length;
	}
	return joined;
}

function derLength(length: number): Uint8Array {
	if (length < 0x80) {
		return Uint8Array.of(length);
	}
	if (length < 0x100) {
		return Uint8Array.of(0x81, length);
	}
	return Uint8Array.of(0x82, length >> 8, length & 0xff);
}

function tlv(tag: number, ...content: readonly Uint8Array[]): Uint8Array {
	const body = concat(...content);
	return concat(Uint8Array.of(tag), derLength(body.length), body);
}

const sequence = (...content: readonly Uint8Array[]) => tlv(0x30, ...content);
const set = (...content: readonly Uint8Array[]) => tlv(0x31, ...content);
const explicit = (n: number, ...content: readonly Uint8Array[]) => tlv(0xa0 + n, ...content);
const octetString = (bytes: Uint8Array) => tlv(0x04, bytes);
const bitString = (bytes: Uint8Array) => tlv(0x03, Uint8Array.of(0), bytes);
const utf8String = (text: string) => tlv(0x0c, new TextEncoder().encode(text));
const printableString = (text: string) => tlv(0x13, new TextEncoder().encode(text));

function integer(value: Uint8Array): Uint8Array {
	const body = (value[0] ?? 0) >= 0x80 ? concat(Uint8Array.of(0), value) : value;
	return tlv(0x02, body);
}

function objectIdentifier(dotted: string): Uint8Array {
	const arcs = dotted.split(".").map(Number);
	const bytes = [40 * (arcs[0] ?? 0) + (arcs[1] ?? 0)];
	for (const arc of arcs.slice(2)) {
		const digits = [arc & 0x7f];
		for (let rest = arc >> 7; rest > 0; rest >>= 7) {
			digits.unshift((rest & 0x7f) | 0x80);
		}
		bytes.push(...digits);
	}
	return tlv(0x06, Uint8Array.from(bytes));
}

function utcTime(date: Date): Uint8Array {
	const pad = (value: number) => String(value).padStart(2, "0");
	const spelled = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
	return tlv(0x17, new TextEncoder().encode(spelled));
}

interface DistinguishedName {
	readonly country: string;
	readonly organisation: string;
	readonly organisationalUnit?: string;
	readonly commonName: string;
}

function name(subject: DistinguishedName): Uint8Array {
	const attribute = (oid: string, value: Uint8Array) => set(sequence(objectIdentifier(oid), value));
	return sequence(
		attribute(COUNTRY, printableString(subject.country)),
		attribute(ORGANISATION, utf8String(subject.organisation)),
		...(subject.organisationalUnit === undefined
			? []
			: [attribute(ORGANISATIONAL_UNIT, utf8String(subject.organisationalUnit))]),
		attribute(COMMON_NAME, utf8String(subject.commonName)),
	);
}

function extension(oid: string, value: Uint8Array, critical = false): Uint8Array {
	return sequence(
		objectIdentifier(oid),
		...(critical ? [tlv(0x01, Uint8Array.of(0xff))] : []),
		octetString(value),
	);
}

function crlDistributionPoint(url: string): Uint8Array {
	const uri = tlv(0x86, new TextEncoder().encode(url));
	return extension(CRL_DISTRIBUTION_POINTS, sequence(sequence(explicit(0, explicit(0, uri)))));
}

interface KeyPair {
	readonly privateKey: CryptoKey;
	readonly publicKey: CryptoKey;
}

async function generateKeyPair(): Promise<KeyPair> {
	const generated = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	]);
	if (!("privateKey" in generated)) {
		throw new Error("the runtime returned a single key where a P-256 pair was asked for");
	}
	return generated;
}

async function sign(key: CryptoKey, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
	const raw = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data);
	return derSignatureOf(new Uint8Array(raw));
}

interface CertificateRequest {
	readonly subject: DistinguishedName;
	readonly issuer: DistinguishedName;
	readonly subjectKey: CryptoKey;
	readonly issuerKey: CryptoKey;
	readonly certificateAuthority: boolean;
	readonly extensions?: readonly Uint8Array[];
	readonly notBefore?: Date;
	readonly notAfter?: Date;
}

async function certificate(request: CertificateRequest): Promise<Uint8Array<ArrayBuffer>> {
	const spki = new Uint8Array(await crypto.subtle.exportKey("spki", request.subjectKey));
	const signatureAlgorithm = sequence(objectIdentifier(ECDSA_WITH_SHA256));
	const now = Date.now();
	const constraints = request.certificateAuthority
		? [
				extension(BASIC_CONSTRAINTS, sequence(tlv(0x01, Uint8Array.of(0xff))), true),
				extension(KEY_USAGE, tlv(0x03, Uint8Array.of(1, 0x06)), true),
			]
		: [extension(BASIC_CONSTRAINTS, sequence())];
	const tbs = sequence(
		explicit(0, integer(Uint8Array.of(2))),
		integer(Uint8Array.from(randomBytes(12))),
		signatureAlgorithm,
		name(request.issuer),
		sequence(
			utcTime(request.notBefore ?? new Date(now - DAY_IN_MS)),
			utcTime(request.notAfter ?? new Date(now + 365 * DAY_IN_MS)),
		),
		name(request.subject),
		spki,
		explicit(3, sequence(...constraints, ...(request.extensions ?? []))),
	);
	const signature = await sign(request.issuerKey, concat(tbs));
	return concat(sequence(tbs, signatureAlgorithm, bitString(signature)));
}

/** the attestation key and the chain from it towards a root, leaf first and the root left out */
export interface AttestationIdentity {
	readonly key: CryptoKey;
	readonly chain: readonly Uint8Array[];
}

export interface TestCertificateAuthority {
	readonly rootDer: Uint8Array<ArrayBuffer>;
	readonly rootPem: string;
	issue(input: {
		readonly aaguid?: string;
		readonly revocationListUrl?: string;
		readonly expired?: boolean;
		readonly throughIntermediate?: boolean;
	}): Promise<AttestationIdentity>;
}

export function pemOf(der: Uint8Array): string {
	const body = Buffer.from(der).toString("base64");
	const lines = body.match(/.{1,64}/g) ?? [];
	return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

function aaguidBytes(aaguid: string): Uint8Array {
	return Uint8Array.from(Buffer.from(aaguid.replaceAll("-", ""), "hex"));
}

/** a root made for one test run, which issues attestation certificates in the shape packed asks for */
export async function createTestCertificateAuthority(
	options: { readonly organisation?: string; readonly revocationListUrl?: string } = {},
): Promise<TestCertificateAuthority> {
	const rootName: DistinguishedName = {
		country: "DE",
		organisation: options.organisation ?? "Velve Test Authenticators",
		commonName: `Velve Test Root ${randomUUID()}`,
	};
	const rootKey = await generateKeyPair();
	const rootDer = await certificate({
		subject: rootName,
		issuer: rootName,
		subjectKey: rootKey.publicKey,
		issuerKey: rootKey.privateKey,
		certificateAuthority: true,
		...(options.revocationListUrl === undefined
			? {}
			: { extensions: [crlDistributionPoint(options.revocationListUrl)] }),
	});
	return {
		rootDer,
		rootPem: pemOf(rootDer),
		async issue(input) {
			const now = Date.now();
			let issuerName = rootName;
			let issuerKey = rootKey.privateKey;
			const intermediates: Uint8Array[] = [];
			if (input.throughIntermediate === true) {
				const intermediateName: DistinguishedName = {
					...rootName,
					commonName: `Velve Test Intermediate ${randomUUID()}`,
				};
				const intermediateKey = await generateKeyPair();
				intermediates.push(
					await certificate({
						subject: intermediateName,
						issuer: rootName,
						subjectKey: intermediateKey.publicKey,
						issuerKey: rootKey.privateKey,
						certificateAuthority: true,
					}),
				);
				issuerName = intermediateName;
				issuerKey = intermediateKey.privateKey;
			}
			const leafKey = await generateKeyPair();
			const leaf = await certificate({
				subject: {
					country: "DE",
					organisation: rootName.organisation,
					organisationalUnit: "Authenticator Attestation",
					commonName: `Velve Test Attestation ${randomUUID()}`,
				},
				issuer: issuerName,
				subjectKey: leafKey.publicKey,
				issuerKey,
				certificateAuthority: false,
				extensions: [
					...(input.aaguid === undefined
						? []
						: [extension(FIDO_GEN_CE_AAGUID, octetString(aaguidBytes(input.aaguid)))]),
					...(input.revocationListUrl === undefined
						? []
						: [crlDistributionPoint(input.revocationListUrl)]),
				],
				...(input.expired === true
					? { notBefore: new Date(now - 3 * DAY_IN_MS), notAfter: new Date(now - DAY_IN_MS) }
					: {}),
			});
			return { key: leafKey.privateKey, chain: [leaf, ...intermediates] };
		},
	};
}

/** the attestation a registration answers with */
export type AttestationKind =
	| { readonly kind: "none" }
	| { readonly kind: "self" }
	| { readonly kind: "packed"; readonly identity: AttestationIdentity };

function sha256(bytes: Uint8Array): Uint8Array {
	return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

function cborHead(majorType: number, value: number): Uint8Array {
	const prefix = majorType << 5;
	if (value < 24) {
		return Uint8Array.of(prefix | value);
	}
	if (value < 0x100) {
		return Uint8Array.of(prefix | 24, value);
	}
	return Uint8Array.of(prefix | 25, value >> 8, value & 0xff);
}

const cborText = (text: string) => {
	const bytes = new TextEncoder().encode(text);
	return concat(cborHead(3, bytes.length), bytes);
};
const cborBytes = (bytes: Uint8Array) => concat(cborHead(2, bytes.length), bytes);
const cborNegative = (value: number) => cborHead(1, -1 - value);

/** a map whose keys the caller already gives in canonical order, shorter encoding first */
function cborMap(entries: readonly (readonly [Uint8Array, Uint8Array])[]): Uint8Array {
	return concat(cborHead(5, entries.length), ...entries.flat());
}

const COSE_ES256 = -7;

async function attestationStatement(
	attestation: AttestationKind,
	signed: Uint8Array<ArrayBuffer>,
	credentialKey: CryptoKey,
): Promise<{ readonly fmt: string; readonly statement: Uint8Array }> {
	if (attestation.kind === "none") {
		return { fmt: "none", statement: cborMap([]) };
	}
	const key = attestation.kind === "self" ? credentialKey : attestation.identity.key;
	const signature = await sign(key, signed);
	const entries: (readonly [Uint8Array, Uint8Array])[] = [
		[cborText("alg"), cborNegative(COSE_ES256)],
		[cborText("sig"), cborBytes(signature)],
	];
	if (attestation.kind === "packed") {
		const chain = attestation.identity.chain;
		entries.push([
			cborText("x5c"),
			concat(cborHead(4, chain.length), ...chain.map((certificate) => cborBytes(certificate))),
		]);
	}
	return { fmt: "packed", statement: cborMap(entries) };
}

function bigEndian(value: number, bytes: number): Uint8Array {
	const encoded = new Uint8Array(bytes);
	for (let index = bytes - 1, rest = value; index >= 0; index -= 1, rest >>>= 8) {
		encoded[index] = rest & 0xff;
	}
	return encoded;
}

const USER_PRESENT_AND_VERIFIED = 0b0000_0101;
const ATTESTED_CREDENTIAL_DATA = 0b0100_0000;

/** an authenticator whose registration carries the attestation the test chose, and which asserts as any passkey does */
export async function createAttestingAuthenticator(options: {
	readonly relyingPartyId: string;
	readonly origin: string;
	readonly aaguid: string;
	readonly attestation: AttestationKind;
	readonly discoverable?: boolean;
}): Promise<VirtualAuthenticator> {
	const credentialKey = await generateKeyPair();
	const jwk = await crypto.subtle.exportKey("jwk", credentialKey.publicKey);
	const coseKey = encodeCbor({
		kind: "map",
		entries: [
			[
				{ kind: "unsigned", value: 1 },
				{ kind: "unsigned", value: 2 },
			],
			[
				{ kind: "unsigned", value: 3 },
				{ kind: "negative", value: COSE_ES256 },
			],
			[
				{ kind: "negative", value: -1 },
				{ kind: "unsigned", value: 1 },
			],
			[
				{ kind: "negative", value: -2 },
				{ kind: "bytes", value: new Uint8Array(Buffer.from(jwk.x ?? "", "base64url")) },
			],
			[
				{ kind: "negative", value: -3 },
				{ kind: "bytes", value: new Uint8Array(Buffer.from(jwk.y ?? "", "base64url")) },
			],
		],
	});
	const credentialId = new Uint8Array(randomBytes(32));
	const rpIdHash = sha256(new TextEncoder().encode(options.relyingPartyId));
	let signCount = 0;
	const clientData = (type: string, challenge: string) =>
		new TextEncoder().encode(
			JSON.stringify({ type, challenge, origin: options.origin, crossOrigin: false }),
		);
	const extensionResults =
		options.discoverable === true ? { credProps: { rk: true } } : ({} as Record<string, never>);

	return {
		credentialId: base64url(credentialId),
		get signCount() {
			return signCount;
		},

		async attest({ challenge }): Promise<RegistrationResponseJSON> {
			signCount += 1;
			const authData = concat(
				rpIdHash,
				Uint8Array.of(USER_PRESENT_AND_VERIFIED | ATTESTED_CREDENTIAL_DATA),
				bigEndian(signCount, 4),
				aaguidBytes(options.aaguid),
				bigEndian(credentialId.length, 2),
				credentialId,
				coseKey,
			);
			const client = clientData("webauthn.create", challenge);
			const { fmt, statement } = await attestationStatement(
				options.attestation,
				concat(authData, sha256(client)),
				credentialKey.privateKey,
			);
			const attestationObject = cborMap([
				[cborText("fmt"), cborText(fmt)],
				[cborText("attStmt"), statement],
				[cborText("authData"), cborBytes(authData)],
			]);
			return {
				id: base64url(credentialId),
				rawId: base64url(credentialId),
				type: "public-key",
				clientExtensionResults: extensionResults,
				response: {
					clientDataJSON: base64url(client),
					attestationObject: base64url(attestationObject),
					transports: ["usb"] as AuthenticatorTransportFuture[],
				},
			};
		},

		async assert({ challenge }): Promise<AuthenticationResponseJSON> {
			signCount += 1;
			const authData = concat(
				rpIdHash,
				Uint8Array.of(USER_PRESENT_AND_VERIFIED),
				bigEndian(signCount, 4),
			);
			const client = clientData("webauthn.get", challenge);
			const signature = await sign(credentialKey.privateKey, concat(authData, sha256(client)));
			return {
				id: base64url(credentialId),
				rawId: base64url(credentialId),
				type: "public-key",
				clientExtensionResults: {},
				response: {
					clientDataJSON: base64url(client),
					authenticatorData: base64url(authData),
					signature: base64url(signature),
				},
			};
		},
	};
}
