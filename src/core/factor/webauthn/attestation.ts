import type { AttestationFormat } from "@simplewebauthn/server/helpers";
import {
	convertCertBufferToPEM,
	decodeAttestationObject,
	getCertificateInfo,
	isoBase64URL,
	validateCertificatePath,
} from "@simplewebauthn/server/helpers";

/** what a verified registration reports about its attestation, before the chain is held to the roots */
interface ReportedAttestation {
	readonly fmt: AttestationFormat;
	readonly aaguid: string | null;
	readonly attestationObject: Uint8Array;
}

const CRL_DISTRIBUTION_POINTS = "2.5.29.31";
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
		if (chain.length === 0 || chain.some(namesARevocationList)) {
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
