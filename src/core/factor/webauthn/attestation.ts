import type { AttestationFormat } from "@simplewebauthn/server/helpers";
import {
	convertCertBufferToPEM,
	decodeAttestationObject,
	getCertificateInfo,
	isoBase64URL,
	validateCertificatePath,
} from "@simplewebauthn/server/helpers";
import { ConcealedError } from "../../http/error-map.js";
import { isRecord } from "../../http/validators.js";
import { decodeBase64Url, encodeBase64Url } from "../../keys/base64url.js";

/** what a verified registration reports about its attestation, before the chain is held to the roots */
interface ReportedAttestation {
	readonly fmt: AttestationFormat;
	readonly aaguid: string | null;
	readonly attestationObject: Uint8Array;
}

const CRL_DISTRIBUTION_POINTS = "2.5.29.31";
const LONGEST_ATTESTATION_OBJECT_BYTES = 32 * 1024;
const MOST_CERTIFICATES_IN_A_CHAIN = 8;

const PEM_CERTIFICATE = /^-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----$/;

function parsesAsACertificate(certificate: Uint8Array<ArrayBuffer>): boolean {
	try {
		getCertificateInfo(certificate);
		return true;
	} catch {
		return false;
	}
}

function pemBodyOf(pem: string): Uint8Array<ArrayBuffer> | null {
	const body = PEM_CERTIFICATE.exec(pem.trim())?.[1]?.replace(/\s/g, "");
	if (body === undefined || !isoBase64URL.isBase64(body)) {
		return null;
	}
	return Uint8Array.from(isoBase64URL.toBuffer(body, "base64"));
}

/** the DER bytes of one certificate given as PEM text or DER bytes, or null where it is neither */
export function certificateBytesOf(root: unknown): Uint8Array<ArrayBuffer> | null {
	const bytes =
		typeof root === "string"
			? pemBodyOf(root)
			: root instanceof Uint8Array
				? Uint8Array.from(root)
				: null;
	return bytes !== null && parsesAsACertificate(bytes) ? bytes : null;
}

//the verifier fetches the revocation list a certificate names before it builds the chain (E-3844)
export function namesARevocationList(certificate: Uint8Array): boolean {
	const extensions =
		getCertificateInfo(Uint8Array.from(certificate)).parsedCertificate.tbsCertificate.extensions ??
		[];
	return extensions.some((extension) => extension.extnID === CRL_DISTRIBUTION_POINTS);
}

const STANDARD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

class UnreadableAttestation extends Error {
	constructor(part: string) {
		super(`the attestation carries ${part} the library cannot read strictly`);
		this.name = "UnreadableAttestation";
	}
}

function strictJsonObjectOf(segment: string | undefined, part: string): Record<string, unknown> {
	const decoded = decodeBase64Url(segment ?? "");
	if (decoded === null) {
		throw new UnreadableAttestation(part);
	}
	const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
	if (!isRecord(parsed)) {
		throw new UnreadableAttestation(part);
	}
	return parsed;
}

function certificateOfStandardBase64(entry: unknown): Uint8Array {
	if (typeof entry !== "string" || !STANDARD_BASE64.test(entry)) {
		throw new UnreadableAttestation("a header certificate");
	}
	return Uint8Array.from(isoBase64URL.toBuffer(entry, "base64"));
}

function certificatesOfJwsHeader(response: unknown): readonly Uint8Array[] {
	if (!(response instanceof Uint8Array)) {
		throw new UnreadableAttestation("a safetynet response");
	}
	const parts = new TextDecoder("utf-8", { fatal: true }).decode(response).split(".");
	if (parts.length !== 3) {
		throw new UnreadableAttestation("a safetynet response");
	}
	const header = strictJsonObjectOf(parts[0], "a safetynet header");
	strictJsonObjectOf(parts[1], "a safetynet payload");
	const chain: unknown = Object.hasOwn(header, "x5c") ? header.x5c : [];
	if (!Array.isArray(chain)) {
		throw new UnreadableAttestation("a safetynet header chain");
	}
	return chain.map(certificateOfStandardBase64);
}

/** the parts of an attestation object the verifier reads, each checked to be the type it must be */
interface ReadAttestationObject {
	readonly authData: Uint8Array;
	readonly certificates: readonly Uint8Array[];
}

function readStrictly(attestationObject: Uint8Array<ArrayBuffer>): ReadAttestationObject {
	const decoded: unknown = decodeAttestationObject(attestationObject);
	if (!(decoded instanceof Map)) {
		throw new UnreadableAttestation("no map");
	}
	const format: unknown = decoded.get("fmt");
	const statement: unknown = decoded.get("attStmt");
	const authData: unknown = decoded.get("authData");
	if (
		typeof format !== "string" ||
		!(statement instanceof Map) ||
		!(authData instanceof Uint8Array)
	) {
		throw new UnreadableAttestation("a map without its three entries");
	}
	const chain: unknown = statement.get("x5c") ?? [];
	if (!Array.isArray(chain) || !chain.every((entry) => entry instanceof Uint8Array)) {
		throw new UnreadableAttestation("an x5c that is no list of certificates");
	}
	const certificates =
		format === "android-safetynet"
			? [...chain, ...certificatesOfJwsHeader(statement.get("response"))]
			: chain;
	if (certificates.length > MOST_CERTIFICATES_IN_A_CHAIN) {
		throw new UnreadableAttestation("a chain longer than any authenticator sends");
	}
	return { authData, certificates };
}

function cborHead(majorType: number, length: number): Uint8Array {
	const prefix = majorType << 5;
	if (length < 24) {
		return Uint8Array.of(prefix | length);
	}
	if (length < 0x100) {
		return Uint8Array.of(prefix | 24, length);
	}
	return Uint8Array.of(prefix | 25, length >> 8, length & 0xff);
}

function cborText(text: string): Uint8Array {
	const bytes = new TextEncoder().encode(text);
	return Uint8Array.of(...cborHead(3, bytes.length), ...bytes);
}

//a rewritten object may change only the format and the statement and must keep the authenticator data byte for byte (E-3855)
function asNoneAttestation(authData: Uint8Array): string {
	const object = new Uint8Array([
		...cborHead(5, 3),
		...cborText("fmt"),
		...cborText("none"),
		...cborText("attStmt"),
		...cborHead(5, 0),
		...cborText("authData"),
		...cborHead(2, authData.length),
		...authData,
	]);
	return encodeBase64Url(object);
}

/** the attestation object the verifier is given, which never holds a certificate naming a revocation list */
export function attestationObjectToVerify(attestationObject: unknown): string {
	const bytes = typeof attestationObject === "string" ? decodeBase64Url(attestationObject) : null;
	if (bytes === null || bytes.length > LONGEST_ATTESTATION_OBJECT_BYTES) {
		throw new ConcealedError("attestation_unreadable");
	}
	let read: ReadAttestationObject;
	let namesAList: boolean;
	try {
		read = readStrictly(bytes);
		namesAList = read.certificates.some(namesARevocationList);
	} catch {
		throw new ConcealedError("attestation_unreadable");
	}
	//a chain the verifier would fetch for must reach it as no attestation at all (E-3855)
	return namesAList ? asNoneAttestation(read.authData) : (attestationObject as string);
}

function chainOf(attestationObject: Uint8Array): readonly Uint8Array[] {
	return (
		decodeAttestationObject(Uint8Array.from(attestationObject)).get("attStmt").get("x5c") ?? []
	);
}

//only a full packed attestation counts and self, none and every other format never does (E-3842)
export async function attestedAaguidOf(
	reported: ReportedAttestation,
	trustedRoots: readonly string[] | null,
): Promise<string | null> {
	if (
		trustedRoots === null ||
		trustedRoots.length === 0 ||
		reported.fmt !== "packed" ||
		reported.aaguid === null
	) {
		return null;
	}
	try {
		const chain = chainOf(reported.attestationObject);
		if (chain.length === 0) {
			return null;
		}
		await validateCertificatePath(
			chain.map((certificate) => convertCertBufferToPEM(Uint8Array.from(certificate))),
			[...trustedRoots],
		);
		return reported.aaguid;
	} catch {
		return null;
	}
}
