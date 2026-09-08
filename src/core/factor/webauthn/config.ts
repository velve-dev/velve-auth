/** Architecture 3.15 A.8. `"discouraged"` is absent because a second factor without user
 * verification is not one, and the discoverable passkey path always demands `"required"`. */
export type RegistrationUserVerification = "required" | "preferred";

export interface WebAuthnConfig {
	readonly relyingPartyId: string;
	readonly relyingPartyName: string;
	readonly origins: readonly string[];
	readonly userVerification?: RegistrationUserVerification;
}

export interface WebAuthnSettings {
	readonly relyingPartyId: string;
	readonly relyingPartyName: string;
	readonly origins: readonly string[];
	readonly registrationUserVerification: RegistrationUserVerification;
}

export const DEFAULT_REGISTRATION_USER_VERIFICATION: RegistrationUserVerification = "required";

export type WebAuthnConfigErrorCode =
	| "relying_party_id_empty"
	| "relying_party_id_is_not_a_hostname"
	| "relying_party_name_empty"
	| "origins_empty"
	| "origin_empty"
	| "origin_carries_more_than_an_origin";

const MESSAGE_BY_ERROR_CODE: Readonly<Record<WebAuthnConfigErrorCode, string>> = {
	relying_party_id_empty: "webauthn.relyingPartyId is empty.",
	relying_party_id_is_not_a_hostname:
		"webauthn.relyingPartyId is a bare hostname, without scheme, port or path.",
	relying_party_name_empty: "webauthn.relyingPartyName is empty.",
	origins_empty: "webauthn.origins names no origin.",
	origin_empty: "webauthn.origins holds an empty entry.",
	origin_carries_more_than_an_origin:
		"An http or https entry of webauthn.origins carries a path, a query or a fragment.",
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

/** A native application's origin is not a URL (`android:apk-key-hash:…`), so only the web
 * spellings are held to a shape (E-452). */
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

export function webAuthnSettingsOf(config: WebAuthnConfig): WebAuthnSettings {
	if (config.relyingPartyName === "") {
		throw new InvalidWebAuthnConfigError("relying_party_name_empty");
	}
	if (config.origins.length === 0) {
		throw new InvalidWebAuthnConfigError("origins_empty");
	}
	return {
		relyingPartyId: assertRelyingPartyId(config.relyingPartyId),
		relyingPartyName: config.relyingPartyName,
		origins: config.origins.map(assertOrigin),
		registrationUserVerification: config.userVerification ?? DEFAULT_REGISTRATION_USER_VERIFICATION,
	};
}
