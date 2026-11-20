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
import { decodeBase64Url } from "../../keys/base64url.js";

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

function certificatesOfJwsHeader(response: unknown): readonly Uint8Array[] {
	if (!(response instanceof Uint8Array)) {
		throw new TypeError("a safetynet statement carries no response");
	}
	const [header] = new TextDecoder().decode(response).split(".");
	const decoded = decodeBase64Url(header ?? "");
	const parsed: unknown = decoded === null ? null : JSON.parse(new TextDecoder().decode(decoded));
	const chain = isRecord(parsed) && Object.hasOwn(parsed, "x5c") ? parsed.x5c : [];
	if (!Array.isArray(chain) || !chain.every((entry) => typeof entry === "string")) {
		throw new TypeError("a safetynet header names no chain of certificates");
	}
	return chain.map((entry) => Uint8Array.from(isoBase64URL.toBuffer(entry, "base64")));
}

function certificatesTheVerifierReads(
	attestationObject: Uint8Array<ArrayBuffer>,
): readonly Uint8Array[] {
	const decoded = decodeAttestationObject(attestationObject);
	const statement: unknown = decoded.get("attStmt");
	if (!(statement instanceof Map)) {
		throw new TypeError("the attestation statement is no map");
	}
	const chain: unknown = statement.get("x5c") ?? [];
	if (!Array.isArray(chain) || !chain.every((entry) => entry instanceof Uint8Array)) {
		throw new TypeError("x5c is no list of certificates");
	}
	return decoded.get("fmt") === "android-safetynet"
		? [...chain, ...certificatesOfJwsHeader(statement.get("response"))]
		: chain;
}

//a certificate the client sends is never handed to a verifier that would fetch the revocation list it names (E-3854)
export function refuseAnAttestationNamingARevocationList(attestationObject: unknown): void {
	const bytes = typeof attestationObject === "string" ? decodeBase64Url(attestationObject) : null;
	if (bytes === null || bytes.length > LONGEST_ATTESTATION_OBJECT_BYTES) {
		throw new ConcealedError("attestation_unreadable");
	}
	let certificates: readonly Uint8Array[];
	try {
		certificates = certificatesTheVerifierReads(bytes);
		if (certificates.length > MOST_CERTIFICATES_IN_A_CHAIN) {
			throw new RangeError("the chain is longer than any authenticator sends");
		}
		if (!certificates.some(namesARevocationList)) {
			return;
		}
	} catch {
		throw new ConcealedError("attestation_unreadable");
	}
	throw new ConcealedError("attestation_names_a_revocation_list");
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
