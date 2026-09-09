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

/** 3.11: a plugin contributes error codes, and each one begins with its own id. */
export type PluginErrorCode = `${string}.${string}`;
export type AnyErrorCode = VelveErrorCode | PluginErrorCode;

export interface PluginErrorDefinition {
	readonly httpStatus: number;
	readonly message: string;
}

const PLUGIN_ERRORS = new Map<PluginErrorCode, PluginErrorDefinition>();
const PLUGIN_ERROR_STATUS_FLOOR = 400;
const PLUGIN_ERROR_STATUS_CEILING = 599;

/** `Object.hasOwn` and not `in`: `in` walks the prototype, so `toString` read as a core code (E-657). */
function isPluginErrorCode(code: AnyErrorCode): code is PluginErrorCode {
	return !Object.hasOwn(MESSAGE_BY_ERROR_CODE, code);
}

/**
 * §3 keeps this file the only place that decides what a caller learns, which is why a plugin
 * registers here rather than widening the core union: the union stays a closed literal and the
 * resolver below answers for both kinds. The registry is process-wide, so a second instance
 * registering the same code with a different answer is refused rather than silently winning
 * (E-720).
 */
export function registerPluginErrorCodes(
	definitions: Readonly<Record<PluginErrorCode, PluginErrorDefinition>>,
): void {
	const entries = Object.entries(definitions) as [PluginErrorCode, PluginErrorDefinition][];
	for (const [code, definition] of entries) {
		if (!isPluginErrorCode(code)) {
			throw new TypeError(`${code} is a core error code and cannot be redefined`);
		}
		if (
			definition.httpStatus < PLUGIN_ERROR_STATUS_FLOOR ||
			definition.httpStatus > PLUGIN_ERROR_STATUS_CEILING
		) {
			throw new TypeError(`${code} must answer with a 4xx or 5xx status`);
		}
		const registered = PLUGIN_ERRORS.get(code);
		if (
			registered !== undefined &&
			(registered.httpStatus !== definition.httpStatus || registered.message !== definition.message)
		) {
			throw new TypeError(`${code} is already registered with a different answer`);
		}
	}
	for (const [code, definition] of entries) {
		PLUGIN_ERRORS.set(code, definition);
	}
}

/**
 * 3.15 G gives a plugin a bare list of code strings and 3.15 F needs a status and a message for
 * every code; a declared code answers with the library's own pair, which says the request was
 * refused and nothing about the plugin. The declaration is held apart from the registrations
 * above, so that a start never blocks the richer answer an application registers for the same
 * code — in either order, the explicit one wins (E-646).
 */
const DECLARED_PLUGIN_ERROR: PluginErrorDefinition = {
	httpStatus: 400,
	message: "The request was refused.",
};

const DECLARED_PLUGIN_CODES = new Set<PluginErrorCode>();

export function registerDeclaredPluginErrorCodes(codes: readonly PluginErrorCode[]): void {
	for (const code of codes) {
		DECLARED_PLUGIN_CODES.add(code);
	}
}

/** Not exported from the package: the registry is process-wide, so a public reset is a way for one caller to erase another's codes. */
export function forgetPluginErrorCodes(): void {
	PLUGIN_ERRORS.clear();
	DECLARED_PLUGIN_CODES.clear();
}

function isKnownPluginErrorCode(code: PluginErrorCode): boolean {
	return PLUGIN_ERRORS.has(code) || DECLARED_PLUGIN_CODES.has(code);
}

const UNREGISTERED: PluginErrorDefinition = {
	httpStatus: HTTP_STATUS_BY_ERROR_CODE.internal_error,
	message: MESSAGE_BY_ERROR_CODE.internal_error,
};

/** The one resolver: a core code reads the two tables, a namespaced one reads the registry. */
export function resolveErrorCode(code: AnyErrorCode): PluginErrorDefinition {
	if (!isPluginErrorCode(code)) {
		return {
			httpStatus: HTTP_STATUS_BY_ERROR_CODE[code],
			message: MESSAGE_BY_ERROR_CODE[code],
		};
	}
	if (DECLARED_PLUGIN_CODES.has(code)) {
		return PLUGIN_ERRORS.get(code) ?? DECLARED_PLUGIN_ERROR;
	}
	return PLUGIN_ERRORS.get(code) ?? UNREGISTERED;
}

/** The one enumeration of the union, so `instance.ts` keeps no second copy of the 25 codes. */
export const VELVE_ERROR_CODES: readonly VelveErrorCode[] = Object.keys(
	MESSAGE_BY_ERROR_CODE,
) as VelveErrorCode[];

export class VelveError extends Error {
	readonly code: AnyErrorCode;
	readonly httpStatus: number;
	readonly retryAfterSeconds?: number;

	constructor(code: AnyErrorCode, options?: { readonly retryAfterSeconds: number }) {
		const resolved = resolveErrorCode(code);
		super(resolved.message);
		this.name = "VelveError";
		this.code = code;
		this.httpStatus = resolved.httpStatus;
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
		readonly code: AnyErrorCode;
		readonly message: string;
		readonly retryAfterSeconds?: number;
	};
}

const RETRY_AFTER_LIMIT_IN_SECONDS = 86_400;

/** A wait the caller cannot act on is not a wait, and it reaches neither the body nor the Retry-After header. */
export function writableWaitInSeconds(retryAfterSeconds: number | undefined): number | null {
	if (retryAfterSeconds === undefined) {
		return null;
	}
	const seconds = Math.ceil(retryAfterSeconds);
	return Number.isInteger(seconds) && seconds >= 0 && seconds <= RETRY_AFTER_LIMIT_IN_SECONDS
		? seconds
		: null;
}

/**
 * A namespaced code nobody declared is not part of any published interface, so the body carries
 * `internal_error` rather than a string the caller cannot look up (E-647).
 */
function visibleCodeOf(code: AnyErrorCode): AnyErrorCode {
	return !isPluginErrorCode(code) || isKnownPluginErrorCode(code) ? code : "internal_error";
}

export function toErrorBody(error: VelveError): ErrorBody {
	const code = visibleCodeOf(error.code);
	const { message } = resolveErrorCode(code);
	const wait = writableWaitInSeconds(error.retryAfterSeconds);
	if (wait === null) {
		return { error: { code, message } };
	}
	return { error: { code, message, retryAfterSeconds: wait } };
}
