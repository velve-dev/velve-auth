import { convertCertBufferToPEM } from "@simplewebauthn/server/helpers";
import { certificateBytesOf, namesARevocationList } from "./attestation.js";

/** the user verification a registration may ask for, where `"discouraged"` is never an option */
export type RegistrationUserVerification = "required" | "preferred";

/** the roots an attestation chain must end in, which turns verified attestation and the authenticator allowlist on */
export interface WebAuthnAttestationConfig {
	/** each root certificate as PEM text or as DER bytes */
	readonly trustedRoots: readonly (string | Uint8Array)[];
	/** asks every registration for attestation and not only one for an account with an allowlist */
	readonly requestForEveryAccount?: boolean;
}

export interface WebAuthnConfig {
	readonly relyingPartyId: string;
	readonly relyingPartyName: string;
	readonly origins: readonly string[];
	readonly userVerification?: RegistrationUserVerification;
	readonly requireDiscoverableCredential?: boolean;
	readonly attestation?: WebAuthnAttestationConfig;
}

/** the checked attestation settings, with every root as PEM text */
export interface WebAuthnAttestationSettings {
	readonly trustedRoots: readonly string[];
	readonly requestForEveryAccount: boolean;
}

export interface WebAuthnSettings {
	readonly relyingPartyId: string;
	readonly relyingPartyName: string;
	readonly origins: readonly string[];
	readonly registrationUserVerification: RegistrationUserVerification;
	readonly requireDiscoverableCredential: boolean;
	readonly attestation: WebAuthnAttestationSettings | null;
}

export const DEFAULT_REGISTRATION_USER_VERIFICATION: RegistrationUserVerification = "required";

export type WebAuthnConfigErrorCode =
	| "relying_party_id_empty"
	| "relying_party_id_is_not_a_hostname"
	| "relying_party_name_empty"
	| "origins_empty"
	| "origin_empty"
	| "origin_carries_more_than_an_origin"
	| "require_discoverable_credential_not_a_boolean"
	| "discoverable_credential_without_user_verification"
	| "attestation_not_an_object"
	| "attestation_roots_empty"
	| "attestation_root_unreadable"
	| "attestation_root_names_a_revocation_list"
	| "attestation_request_for_every_account_not_a_boolean";

const MESSAGE_BY_ERROR_CODE: Readonly<Record<WebAuthnConfigErrorCode, string>> = {
	relying_party_id_empty: "webauthn.relyingPartyId is empty.",
	relying_party_id_is_not_a_hostname:
		"webauthn.relyingPartyId is a bare hostname, without scheme, port or path.",
	relying_party_name_empty: "webauthn.relyingPartyName is empty.",
	origins_empty: "webauthn.origins names no origin.",
	origin_empty: "webauthn.origins holds an empty entry.",
	origin_carries_more_than_an_origin:
		"An http or https entry of webauthn.origins carries a path, a query or a fragment.",
	require_discoverable_credential_not_a_boolean:
		"webauthn.requireDiscoverableCredential is true, false or absent.",
	discoverable_credential_without_user_verification:
		'webauthn.requireDiscoverableCredential asks for user verification, so webauthn.userVerification cannot be "preferred".',
	attestation_not_an_object: "webauthn.attestation is an object carrying trustedRoots, or absent.",
	attestation_roots_empty: "webauthn.attestation.trustedRoots names no root certificate.",
	attestation_root_unreadable:
		"An entry of webauthn.attestation.trustedRoots is no X.509 certificate in PEM text or DER bytes.",
	attestation_root_names_a_revocation_list:
		"An entry of webauthn.attestation.trustedRoots names a CRL distribution point, which verifying a chain would fetch.",
	attestation_request_for_every_account_not_a_boolean:
		"webauthn.attestation.requestForEveryAccount is true, false or absent.",
};

export class InvalidWebAuthnConfigError extends Error {
	readonly code: WebAuthnConfigErrorCode;

	constructor(code: WebAuthnConfigErrorCode) {
		super(MESSAGE_BY_ERROR_CODE[code]);
		this.name = "InvalidWebAuthnConfigError";
		this.code = code;
	}
}

function assertRelyingPartyId(relyingPartyId: string): string {
	if (relyingPartyId === "") {
		throw new InvalidWebAuthnConfigError("relying_party_id_empty");
	}
	if (/[:/\s?#]/.test(relyingPartyId)) {
		throw new InvalidWebAuthnConfigError("relying_party_id_is_not_a_hostname");
	}
	return relyingPartyId;
}

//a native app origin is not a url so only web origins are held to a shape (E-452)
function assertOrigin(origin: string): string {
	if (origin === "") {
		throw new InvalidWebAuthnConfigError("origin_empty");
	}
	if (!/^https?:\/\//i.test(origin)) {
		return origin;
	}
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		throw new InvalidWebAuthnConfigError("origin_carries_more_than_an_origin");
	}
	if (parsed.origin !== origin) {
		throw new InvalidWebAuthnConfigError("origin_carries_more_than_an_origin");
	}
	return origin;
}

//a switch a caller misspelled must not read as off (S-DEFAULT-8)
function discoverableCredentialRequired(config: WebAuthnConfig): boolean {
	const required: unknown = config.requireDiscoverableCredential;
	if (required === undefined) {
		return false;
	}
	if (typeof required !== "boolean") {
		throw new InvalidWebAuthnConfigError("require_discoverable_credential_not_a_boolean");
	}
	return required;
}

//a contradiction is refused at start rather than settled by silently overriding one side (E-3811)
function assertUserVerificationAllows(
	requireDiscoverableCredential: boolean,
	userVerification: RegistrationUserVerification,
): RegistrationUserVerification {
	if (requireDiscoverableCredential && userVerification !== "required") {
		throw new InvalidWebAuthnConfigError("discoverable_credential_without_user_verification");
	}
	return userVerification;
}

//a switch a caller misspelled must not read as off (S-DEFAULT-8)
function requestedForEveryAccount(attestation: WebAuthnAttestationConfig): boolean {
	const requested: unknown = attestation.requestForEveryAccount;
	if (requested === undefined) {
		return false;
	}
	if (typeof requested !== "boolean") {
		throw new InvalidWebAuthnConfigError("attestation_request_for_every_account_not_a_boolean");
	}
	return requested;
}

//a root nobody could parse is refused at the start and never reaches a chain verification (E-3843)
function trustedRootOf(root: unknown): string {
	const certificate = certificateBytesOf(root);
	if (certificate === null) {
		throw new InvalidWebAuthnConfigError("attestation_root_unreadable");
	}
	if (namesARevocationList(certificate)) {
		throw new InvalidWebAuthnConfigError("attestation_root_names_a_revocation_list");
	}
	return convertCertBufferToPEM(certificate);
}

function attestationSettingsOf(config: WebAuthnConfig): WebAuthnAttestationSettings | null {
	const attestation: unknown = config.attestation;
	if (attestation === undefined) {
		return null;
	}
	if (typeof attestation !== "object" || attestation === null) {
		throw new InvalidWebAuthnConfigError("attestation_not_an_object");
	}
	const roots: unknown = (attestation as WebAuthnAttestationConfig).trustedRoots;
	if (!Array.isArray(roots) || roots.length === 0) {
		throw new InvalidWebAuthnConfigError("attestation_roots_empty");
	}
	return {
		trustedRoots: roots.map(trustedRootOf),
		requestForEveryAccount: requestedForEveryAccount(attestation as WebAuthnAttestationConfig),
	};
}

export function webAuthnSettingsOf(config: WebAuthnConfig): WebAuthnSettings {
	if (config.relyingPartyName === "") {
		throw new InvalidWebAuthnConfigError("relying_party_name_empty");
	}
	if (config.origins.length === 0) {
		throw new InvalidWebAuthnConfigError("origins_empty");
	}
	const requireDiscoverableCredential = discoverableCredentialRequired(config);
	return {
		relyingPartyId: assertRelyingPartyId(config.relyingPartyId),
		relyingPartyName: config.relyingPartyName,
		origins: config.origins.map(assertOrigin),
		registrationUserVerification: assertUserVerificationAllows(
			requireDiscoverableCredential,
			config.userVerification ?? DEFAULT_REGISTRATION_USER_VERIFICATION,
		),
		requireDiscoverableCredential,
		attestation: attestationSettingsOf(config),
	};
}
