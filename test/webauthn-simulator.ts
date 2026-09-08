import { createHash, randomBytes } from "node:crypto";
import type {
	AuthenticationResponseJSON,
	AuthenticatorTransportFuture,
	RegistrationResponseJSON,
} from "@simplewebauthn/server";

/**
 * The other side of the WebAuthn conversation (architecture 6.19). `@simplewebauthn/server`
 * checks attestations and assertions; nothing in the test tree produces one, so origin binding,
 * relying-party binding, challenge single use, the user-verification policy, the backup flags
 * and the sign counter could only be exercised by hand. Encoding is Node's here — a simulator
 * that shared the library's base64url and CBOR would agree with it about a shared mistake.
 */

const P256_COORDINATE_BYTES = 32;
const AAGUID_BYTES = 16;

const USER_PRESENT = 0b0000_0001;
const USER_VERIFIED = 0b0000_0100;
const BACKUP_ELIGIBLE = 0b0000_1000;
const BACKUP_STATE = 0b0001_0000;
const ATTESTED_CREDENTIAL_DATA = 0b0100_0000;

interface AuthenticatorFlags {
	readonly userPresent?: boolean;
	readonly userVerified?: boolean;
	readonly backupEligible?: boolean;
	readonly backupState?: boolean;
}

/** A rejection nobody can produce is a rejection nobody has tested (architecture 6.19). */
export type SignatureFault =
	| "another-key"
	| "corrupted-signature"
	| "empty-signature"
	| "signed-without-the-client-data"
	/** Sign correctly, then transmit different client data. Challenge, origin and relying party
	 * all still check out, so nothing but the signature's binding to the transmitted bytes can
	 * refuse it — which `signed-without-the-client-data` only tests obliquely (E-484). */
	| "client-data-exchanged-after-signing";

export interface CeremonyOverrides {
	readonly flags?: AuthenticatorFlags;
	readonly signCount?: number;
	readonly origin?: string;
	readonly relyingPartyId?: string;
	readonly clientDataType?: string;
}

export interface AssertionOverrides extends CeremonyOverrides {
	readonly signatureFault?: SignatureFault;
	readonly credentialId?: string;
	readonly userHandle?: string;
}

interface VirtualAuthenticatorOptions {
	readonly relyingPartyId: string;
	readonly origin: string;
	readonly aaguid?: Uint8Array;
	readonly signCount?: number;
	readonly transports?: readonly string[];
	readonly flags?: AuthenticatorFlags;
}

export interface VirtualAuthenticator {
	readonly credentialId: string;
	readonly signCount: number;
	attest(input: { challenge: string } & CeremonyOverrides): Promise<RegistrationResponseJSON>;
	assert(input: { challenge: string } & AssertionOverrides): Promise<AuthenticationResponseJSON>;
}

function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.length;
	}
	return joined;
}

function sha256(bytes: Uint8Array): Uint8Array {
	return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function cborHead(majorType: number, value: number): Uint8Array {
	const prefix = majorType << 5;
	if (value < 24) {
		return Uint8Array.of(prefix | value);
	}
	if (value < 0x100) {
		return Uint8Array.of(prefix | 24, value);
	}
	if (value < 0x1_00_00) {
		return Uint8Array.of(prefix | 25, value >> 8, value & 0xff);
	}
	return Uint8Array.of(
		prefix | 26,
		(value >>> 24) & 0xff,
		(value >>> 16) & 0xff,
		(value >>> 8) & 0xff,
		value & 0xff,
	);
}

type CborValue =
	| { readonly kind: "unsigned"; readonly value: number }
	| { readonly kind: "negative"; readonly value: number }
	| { readonly kind: "bytes"; readonly value: Uint8Array }
	| { readonly kind: "text"; readonly value: string }
	| { readonly kind: "map"; readonly entries: readonly (readonly [CborValue, CborValue])[] };

/** RFC 8949 §4.2.1 ordering: shorter encoded key first, then bytewise. `@levischuck/tiny-cbor`
 * re-encodes what it decodes and compares lengths, so a non-canonical map moves its pointers. */
export function encodeCbor(value: CborValue): Uint8Array {
	switch (value.kind) {
		case "unsigned":
			return cborHead(0, value.value);
		case "negative":
			return cborHead(1, -1 - value.value);
		case "bytes":
			return concat(cborHead(2, value.value.length), value.value);
		case "text": {
			const utf8 = new TextEncoder().encode(value.value);
			return concat(cborHead(3, utf8.length), utf8);
		}
		case "map": {
			const encoded = value.entries
				.map(([key, item]) => [encodeCbor(key), encodeCbor(item)] as const)
				.sort(([left], [right]) => compareCanonically(left, right));
			return concat(cborHead(5, encoded.length), ...encoded.flat());
		}
	}
}

function compareCanonically(left: Uint8Array, right: Uint8Array): number {
	if (left.length !== right.length) {
		return left.length - right.length;
	}
	for (let index = 0; index < left.length; index += 1) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) {
			return difference;
		}
	}
	return 0;
}

const COSE_KEY_TYPE = 1;
const COSE_ALGORITHM = 3;
const COSE_CURVE = -1;
const COSE_X = -2;
const COSE_Y = -3;
const COSE_KEY_TYPE_EC2 = 2;
const COSE_ALGORITHM_ES256 = -7;
const COSE_CURVE_P256 = 1;

function coseKeyOf(x: Uint8Array, y: Uint8Array): Uint8Array {
	return encodeCbor({
		kind: "map",
		entries: [
			[
				{ kind: "unsigned", value: COSE_KEY_TYPE },
				{ kind: "unsigned", value: COSE_KEY_TYPE_EC2 },
			],
			[
				{ kind: "unsigned", value: COSE_ALGORITHM },
				{ kind: "negative", value: COSE_ALGORITHM_ES256 },
			],
			[
				{ kind: "negative", value: COSE_CURVE },
				{ kind: "unsigned", value: COSE_CURVE_P256 },
			],
			[
				{ kind: "negative", value: COSE_X },
				{ kind: "bytes", value: x },
			],
			[
				{ kind: "negative", value: COSE_Y },
				{ kind: "bytes", value: y },
			],
		],
	});
}

function flagByte(flags: AuthenticatorFlags, attestedCredentialData: boolean): number {
	return (
		(flags.userPresent === false ? 0 : USER_PRESENT) |
		(flags.userVerified === false ? 0 : USER_VERIFIED) |
		(flags.backupEligible === true ? BACKUP_ELIGIBLE : 0) |
		(flags.backupState === true ? BACKUP_STATE : 0) |
		(attestedCredentialData ? ATTESTED_CREDENTIAL_DATA : 0)
	);
}

function bigEndian32(value: number): Uint8Array {
	return Uint8Array.of(
		(value >>> 24) & 0xff,
		(value >>> 16) & 0xff,
		(value >>> 8) & 0xff,
		value & 0xff,
	);
}

function bigEndian16(value: number): Uint8Array {
	return Uint8Array.of((value >> 8) & 0xff, value & 0xff);
}

function authenticatorData(input: {
	relyingPartyId: string;
	flags: AuthenticatorFlags;
	signCount: number;
	attested?: { aaguid: Uint8Array; credentialId: Uint8Array; coseKey: Uint8Array };
}): Uint8Array {
	const head = concat(
		sha256(new TextEncoder().encode(input.relyingPartyId)),
		Uint8Array.of(flagByte(input.flags, input.attested !== undefined)),
		bigEndian32(input.signCount),
	);
	if (input.attested === undefined) {
		return head;
	}
	return concat(
		head,
		input.attested.aaguid,
		bigEndian16(input.attested.credentialId.length),
		input.attested.credentialId,
		input.attested.coseKey,
	);
}

function clientData(input: {
	type: string;
	challenge: string;
	origin: string;
	crossOrigin?: boolean;
}): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify({
			type: input.type,
			challenge: input.challenge,
			origin: input.origin,
			crossOrigin: input.crossOrigin ?? false,
		}),
	);
}

function unsignedDerInteger(value: Uint8Array): Uint8Array {
	let start = 0;
	while (start < value.length - 1 && value[start] === 0) {
		start += 1;
	}
	const trimmed = value.subarray(start);
	const body = (trimmed[0] ?? 0) >= 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed;
	return concat(Uint8Array.of(0x02, body.length), body);
}

/** WebCrypto answers with the raw `r ‖ s` of IEEE P1363; WebAuthn carries ES256 as ASN.1 DER. */
export function derSignatureOf(rawSignature: Uint8Array): Uint8Array {
	const r = unsignedDerInteger(rawSignature.subarray(0, P256_COORDINATE_BYTES));
	const s = unsignedDerInteger(rawSignature.subarray(P256_COORDINATE_BYTES));
	return concat(Uint8Array.of(0x30, r.length + s.length), r, s);
}

async function signWith(key: CryptoKey, message: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
	const raw = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, message);
	return derSignatureOf(new Uint8Array(raw));
}

interface SigningKeyPair {
	readonly privateKey: CryptoKey;
	readonly publicKey: CryptoKey;
}

async function generateSigningKey(): Promise<SigningKeyPair> {
	const generated = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	]);
	if (!("privateKey" in generated)) {
		throw new Error("the runtime returned a single key where a P-256 pair was asked for");
	}
	return generated;
}

async function publicCoordinatesOf(key: CryptoKey): Promise<{ x: Uint8Array; y: Uint8Array }> {
	const jwk = await crypto.subtle.exportKey("jwk", key);
	return {
		x: new Uint8Array(Buffer.from(jwk.x ?? "", "base64url")),
		y: new Uint8Array(Buffer.from(jwk.y ?? "", "base64url")),
	};
}

function faultedSignature(signature: Uint8Array, fault: SignatureFault | undefined): Uint8Array {
	if (fault !== "corrupted-signature") {
		return signature;
	}
	const corrupted = Uint8Array.from(signature);
	const last = corrupted.length - 1;
	corrupted[last] = (corrupted[last] ?? 0) ^ 0xff;
	return corrupted;
}

export async function createVirtualAuthenticator(
	options: VirtualAuthenticatorOptions,
): Promise<VirtualAuthenticator> {
	const keyPair = await generateSigningKey();
	const strangerKeyPair = await generateSigningKey();
	const { x, y } = await publicCoordinatesOf(keyPair.publicKey);
	const coseKey = coseKeyOf(x, y);
	const credentialId = new Uint8Array(randomBytes(32));
	const aaguid = options.aaguid ?? new Uint8Array(AAGUID_BYTES);
	const baseFlags = options.flags ?? {};
	let signCount = options.signCount ?? 0;

	function flagsFor(overrides: AuthenticatorFlags | undefined): AuthenticatorFlags {
		return { ...baseFlags, ...overrides };
	}

	/** An explicit count moves the authenticator's counter there, so a test can make it fall back
	 * and then watch the next ceremony continue from where it was put. */
	function nextSignCount(override: number | undefined): number {
		signCount = override ?? signCount + 1;
		return signCount;
	}

	async function signatureOver(
		data: Uint8Array,
		client: Uint8Array,
		fault: SignatureFault | undefined,
	): Promise<Uint8Array> {
		if (fault === "empty-signature") {
			return new Uint8Array(0);
		}
		const message =
			fault === "signed-without-the-client-data" ? concat(data) : concat(data, sha256(client));
		const key = fault === "another-key" ? strangerKeyPair.privateKey : keyPair.privateKey;
		return faultedSignature(await signWith(key, message), fault);
	}

	return {
		credentialId: base64url(credentialId),

		get signCount() {
			return signCount;
		},

		async attest(input) {
			const data = authenticatorData({
				relyingPartyId: input.relyingPartyId ?? options.relyingPartyId,
				flags: flagsFor(input.flags),
				signCount: nextSignCount(input.signCount),
				attested: { aaguid, credentialId, coseKey },
			});
			const attestationObject = encodeCbor({
				kind: "map",
				entries: [
					[
						{ kind: "text", value: "fmt" },
						{ kind: "text", value: "none" },
					],
					[
						{ kind: "text", value: "attStmt" },
						{ kind: "map", entries: [] },
					],
					[
						{ kind: "text", value: "authData" },
						{ kind: "bytes", value: data },
					],
				],
			});
			const client = clientData({
				type: input.clientDataType ?? "webauthn.create",
				challenge: input.challenge,
				origin: input.origin ?? options.origin,
			});
			return {
				id: base64url(credentialId),
				rawId: base64url(credentialId),
				type: "public-key",
				clientExtensionResults: {},
				response: {
					clientDataJSON: base64url(client),
					attestationObject: base64url(attestationObject),
					transports: [...(options.transports ?? ["internal"])] as AuthenticatorTransportFuture[],
				},
			};
		},

		async assert(input) {
			const data = authenticatorData({
				relyingPartyId: input.relyingPartyId ?? options.relyingPartyId,
				flags: flagsFor(input.flags),
				signCount: nextSignCount(input.signCount),
			});
			const client = clientData({
				type: input.clientDataType ?? "webauthn.get",
				challenge: input.challenge,
				origin: input.origin ?? options.origin,
			});
			const transmittedClient =
				input.signatureFault === "client-data-exchanged-after-signing"
					? clientData({
							type: input.clientDataType ?? "webauthn.get",
							challenge: input.challenge,
							origin: input.origin ?? options.origin,
							crossOrigin: true,
						})
					: client;
			const signature = await signatureOver(data, client, input.signatureFault);
			return {
				id: input.credentialId ?? base64url(credentialId),
				rawId: input.credentialId ?? base64url(credentialId),
				type: "public-key",
				clientExtensionResults: {},
				response: {
					clientDataJSON: base64url(transmittedClient),
					authenticatorData: base64url(data),
					signature: base64url(signature),
					...(input.userHandle === undefined ? {} : { userHandle: input.userHandle }),
				},
			};
		},
	};
}
