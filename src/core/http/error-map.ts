export type VelveErrorCode =
	| "invalid_input"
	| "origin_not_allowed"
	| "rate_limited"
	| "invalid_credentials"
	| "account_disabled"
	| "session_required"
	| "freshness_required"
	| "invalid_token"
	| "invalid_factor_code"
	| "invalid_recovery_code"
	| "invalid_pending_authentication"
	| "too_many_factor_attempts"
	| "password_unacceptable"
	| "username_taken"
	| "username_invalid"
	| "factor_not_enrolled"
	| "factor_already_enrolled"
	| "last_sign_in_method"
	| "identity_already_linked"
	| "provider_not_configured"
	| "oauth_flow_invalid"
	| "oauth_provider_error"
	| "webauthn_challenge_invalid"
	| "webauthn_credential_rejected"
	| "internal_error";

const HTTP_STATUS_BY_ERROR_CODE: Readonly<Record<VelveErrorCode, number>> = {
	invalid_input: 400,
	origin_not_allowed: 403,
	rate_limited: 429,
	invalid_credentials: 401,
	account_disabled: 403,
	session_required: 401,
	freshness_required: 403,
	invalid_token: 400,
	invalid_factor_code: 401,
	invalid_recovery_code: 401,
	invalid_pending_authentication: 401,
	too_many_factor_attempts: 429,
	password_unacceptable: 400,
	username_taken: 409,
	username_invalid: 400,
	factor_not_enrolled: 409,
	factor_already_enrolled: 409,
	last_sign_in_method: 409,
	identity_already_linked: 409,
	provider_not_configured: 400,
	oauth_flow_invalid: 400,
	oauth_provider_error: 502,
	webauthn_challenge_invalid: 400,
	webauthn_credential_rejected: 401,
	internal_error: 500,
};

const MESSAGE_BY_ERROR_CODE: Readonly<Record<VelveErrorCode, string>> = {
	invalid_input: "The request input is not valid.",
	origin_not_allowed: "The request origin is not allowed.",
	rate_limited: "Too many requests.",
	invalid_credentials: "The credentials are not valid.",
	account_disabled: "The account is disabled.",
	session_required: "A valid session is required.",
	freshness_required: "A recent sign-in is required.",
	invalid_token: "The token is not valid.",
	invalid_factor_code: "The code is not valid.",
	invalid_recovery_code: "The recovery code is not valid.",
	invalid_pending_authentication: "The pending authentication is not valid.",
	too_many_factor_attempts: "Too many attempts for this pending authentication.",
	password_unacceptable: "The password does not meet the length requirements.",
	username_taken: "The username is taken.",
	username_invalid: "The username is not valid.",
	factor_not_enrolled: "The factor is not enrolled.",
	factor_already_enrolled: "The factor is already enrolled.",
	last_sign_in_method: "The last remaining sign-in method cannot be removed.",
	identity_already_linked: "The identity belongs to another account.",
	provider_not_configured: "The provider is not configured.",
	oauth_flow_invalid: "The authorization flow is not valid.",
	oauth_provider_error: "The provider did not answer correctly.",
	webauthn_challenge_invalid: "The challenge is not valid.",
	webauthn_credential_rejected: "The credential was rejected.",
	internal_error: "The request could not be completed.",
};

export class VelveError extends Error {
	readonly code: VelveErrorCode;
	readonly httpStatus: number;
	readonly retryAfterSeconds?: number;

	constructor(code: VelveErrorCode, options?: { readonly retryAfterSeconds: number }) {
		super(MESSAGE_BY_ERROR_CODE[code]);
		this.name = "VelveError";
		this.code = code;
		this.httpStatus = HTTP_STATUS_BY_ERROR_CODE[code];
		if (options !== undefined) {
			this.retryAfterSeconds = options.retryAfterSeconds;
		}
	}
}

export type ConcealedReason =
	| "user_not_found"
	| "password_mismatch"
	| "no_password_credential"
	| "legacy_scheme_rejected"
	| "user_disabled_on_sign_in"
	| "cookie_absent"
	| "session_not_found"
	| "session_idle_expired"
	| "session_absolute_expired"
	| "token_not_found"
	| "token_expired"
	| "token_consumed"
	| "token_purpose_mismatch"
	| "email_taken_on_change"
	| "user_disabled_on_token_redemption"
	| "totp_code_wrong"
	| "totp_step_replayed"
	| "totp_not_confirmed"
	| "recovery_code_not_found"
	| "recovery_codes_exhausted"
	| "recovery_codes_never_generated"
	| "pending_not_found"
	| "pending_expired"
	| "pending_consumed"
	| "pending_cookie_absent"
	| "state_not_found"
	| "state_expired"
	| "pkce_mismatch"
	| "nonce_mismatch"
	| "issuer_mismatch"
	| "id_token_signature_invalid"
	| "user_disabled_on_oauth_flow"
	| "challenge_not_found"
	| "challenge_expired"
	| "challenge_purpose_mismatch"
	| "credential_unknown"
	| "signature_invalid"
	| "rp_id_mismatch"
	| "origin_mismatch"
	| "user_not_verified"
	| "user_disabled_on_webauthn_assertion";

const VISIBLE_CODE_BY_CONCEALED_REASON: Readonly<Record<ConcealedReason, VelveErrorCode>> = {
	user_not_found: "invalid_credentials",
	password_mismatch: "invalid_credentials",
	no_password_credential: "invalid_credentials",
	legacy_scheme_rejected: "invalid_credentials",
	user_disabled_on_sign_in: "invalid_credentials",
	cookie_absent: "session_required",
	session_not_found: "session_required",
	session_idle_expired: "session_required",
	session_absolute_expired: "session_required",
	token_not_found: "invalid_token",
	token_expired: "invalid_token",
	token_consumed: "invalid_token",
	token_purpose_mismatch: "invalid_token",
	email_taken_on_change: "invalid_token",
	user_disabled_on_token_redemption: "invalid_token",
	totp_code_wrong: "invalid_factor_code",
	totp_step_replayed: "invalid_factor_code",
	totp_not_confirmed: "invalid_factor_code",
	recovery_code_not_found: "invalid_recovery_code",
	recovery_codes_exhausted: "invalid_recovery_code",
	recovery_codes_never_generated: "invalid_recovery_code",
	pending_not_found: "invalid_pending_authentication",
	pending_expired: "invalid_pending_authentication",
	pending_consumed: "invalid_pending_authentication",
	pending_cookie_absent: "invalid_pending_authentication",
	state_not_found: "oauth_flow_invalid",
	state_expired: "oauth_flow_invalid",
	pkce_mismatch: "oauth_flow_invalid",
	nonce_mismatch: "oauth_flow_invalid",
	issuer_mismatch: "oauth_flow_invalid",
	id_token_signature_invalid: "oauth_flow_invalid",
	user_disabled_on_oauth_flow: "oauth_flow_invalid",
	challenge_not_found: "webauthn_challenge_invalid",
	challenge_expired: "webauthn_challenge_invalid",
	challenge_purpose_mismatch: "webauthn_challenge_invalid",
	credential_unknown: "webauthn_credential_rejected",
	signature_invalid: "webauthn_credential_rejected",
	rp_id_mismatch: "webauthn_credential_rejected",
	origin_mismatch: "webauthn_credential_rejected",
	user_not_verified: "webauthn_credential_rejected",
	user_disabled_on_webauthn_assertion: "webauthn_credential_rejected",
};

export class ConcealedError extends Error {
	readonly reason: ConcealedReason;

	constructor(reason: ConcealedReason) {
		super(reason);
		this.name = "ConcealedError";
		this.reason = reason;
	}
}

interface VisibleFailure {
	readonly error: VelveError;
	readonly loggedReason: string;
	readonly diagnostic?: string;
}

export function toVisibleFailure(cause: unknown): VisibleFailure {
	if (cause instanceof ConcealedError) {
		return {
			error: new VelveError(VISIBLE_CODE_BY_CONCEALED_REASON[cause.reason]),
			loggedReason: cause.reason,
		};
	}
	if (cause instanceof VelveError) {
		return { error: cause, loggedReason: cause.code };
	}
	return {
		error: new VelveError("internal_error"),
		loggedReason: "unhandled_exception",
		diagnostic: cause instanceof Error ? cause.message : String(cause),
	};
}

interface ErrorBody {
	readonly error: {
		readonly code: VelveErrorCode;
		readonly message: string;
		readonly retryAfterSeconds?: number;
	};
}

export function toErrorBody(error: VelveError): ErrorBody {
	if (error.retryAfterSeconds === undefined) {
		return { error: { code: error.code, message: MESSAGE_BY_ERROR_CODE[error.code] } };
	}
	return {
		error: {
			code: error.code,
			message: MESSAGE_BY_ERROR_CODE[error.code],
			retryAfterSeconds: error.retryAfterSeconds,
		},
	};
}
