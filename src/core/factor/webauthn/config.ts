/** the user verification a registration may ask for, where `"discouraged"` is never an option */
export type RegistrationUserVerification = "required" | "preferred";

export interface WebAuthnConfig {
	readonly relyingPartyId: string;
	readonly relyingPartyName: string;
	readonly origins: readonly string[];
	readonly userVerification?: RegistrationUserVerification;
	readonly requireDiscoverableCredential?: boolean;
}

export interface WebAuthnSettings {
	readonly relyingPartyId: string;
	readonly relyingPartyName: string;
	readonly origins: readonly string[];
	readonly registrationUserVerification: RegistrationUserVerification;
	readonly requireDiscoverableCredential: boolean;
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
	| "discoverable_credential_without_user_verification";

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
	};
}
