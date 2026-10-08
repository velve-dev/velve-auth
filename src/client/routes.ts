import type { SignInResult, SignUpResult } from "../core/auth/results.js";
import type { ResolvedSessionView, UsernameAvailabilityAnswer } from "../core/auth/routes.js";
import type { User } from "../core/auth/user.js";
import type { TotpEnrollment } from "../core/factor/totp/secret.js";
import type { WebAuthnCredential } from "../core/factor/webauthn/credential-repository.js";
import type {
	WebAuthnAuthenticationChallenge,
	WebAuthnRegistrationChallenge,
} from "../core/factor/webauthn/service.js";
import type { ChangedUser, SetPasswordResult } from "../core/flows/results.js";
import type { PendingAuthentication, Session } from "../core/http/caller.js";
import type { AnyRoute, HttpMethod, Route } from "../core/http/route.js";
import type { OAuthRouteTable } from "../core/oauth/routes.js";

//the table names its routes and never the services that build them, which stay off the declarations (E-3488)
/** every route the library declares, whatever one instance's mode or configuration serves */
export type VelveRouteTable = readonly [
	Route<
		"signOut",
		"/sign-out",
		{} & {},
		void,
		"invalid_input" | "rate_limited" | "origin_not_allowed"
	>,
	Route<
		"session.read",
		"/session",
		{} & {},
		ResolvedSessionView | null,
		"origin_not_allowed" | "account_disabled"
	>,
	Route<
		"session.list",
		"/session/list",
		{} & {},
		Session[],
		| "rate_limited"
		| "origin_not_allowed"
		| "account_disabled"
		| "session_required"
		| "freshness_required"
	>,
	Route<
		"session.revoke",
		"/session/revoke",
		{
			targetSessionId: string;
		} & {},
		void,
		| "invalid_input"
		| "rate_limited"
		| "origin_not_allowed"
		| "account_disabled"
		| "session_required"
		| "freshness_required"
	>,
	Route<
		"session.revokeAllOther",
		"/session/revoke-others",
		{} & {},
		{
			revokedCount: number;
		},
		| "rate_limited"
		| "origin_not_allowed"
		| "account_disabled"
		| "session_required"
		| "freshness_required"
	>,
	Route<
		"session.revokeAll",
		"/session/revoke-all",
		{} & {},
		{
			revokedCount: number;
		},
		| "rate_limited"
		| "origin_not_allowed"
		| "account_disabled"
		| "session_required"
		| "freshness_required"
	>,
	Route<
		"session.refresh",
		"/session/refresh",
		{} & {},
		ResolvedSessionView | null,
		"rate_limited" | "origin_not_allowed" | "account_disabled" | "session_required"
	>,
	Route<
		"username.isAvailable",
		"/username/available",
		{
			username: string;
		} & {},
		UsernameAvailabilityAnswer,
		"invalid_input" | "rate_limited" | "origin_not_allowed"
	>,
	Route<
		"username.change",
		"/username/change",
		{
			newUsername: string;
		} & {},
		{
			readonly user: User;
		},
		| "invalid_input"
		| "rate_limited"
		| "origin_not_allowed"
		| "account_disabled"
		| "session_required"
		| "freshness_required"
		| "username_taken"
		| "username_invalid"
	>,
	Route<"pending.read", "/pending", {} & {}, PendingAuthentication | null, "origin_not_allowed">,
	Route<
		"pending.cancel",
		"/pending/cancel",
		{} & {},
		void,
		"invalid_input" | "rate_limited" | "origin_not_allowed"
	>,
	...OAuthRouteTable,
	Route<
		"signUp.withPassword",
		"/sign-up",
		{
			username: string;
			email: string;
			password: string;
		} & {},
		SignUpResult,
		| "invalid_input"
		| "rate_limited"
		| "origin_not_allowed"
		| "password_unacceptable"
		| "username_taken"
		| "username_invalid"
	>,
	Route<
		"signUp.withoutPassword",
		"/sign-up/passwordless",
		{
			username: string;
			email: string;
		} & {},
		SignUpResult,
		"invalid_input" | "rate_limited" | "origin_not_allowed" | "username_taken" | "username_invalid"
	>,
	Route<
		"password.redeemResetWithRecoveryCode",
		"/password/redeem-reset-with-recovery-code",
		{
			username: string;
			email: string;
			emailOrUsername: string;
			recoveryCode: string;
			newPassword: string;
		} & {},
		SetPasswordResult,
		| "invalid_input"
		| "rate_limited"
		| "origin_not_allowed"
		| "invalid_recovery_code"
		| "password_unacceptable"
	>,
	Route<
		"signIn.magicLink.request",
		"/sign-in/magic-link/request",
		{
			email: string;
		} & {},
		void,
		"invalid_input" | "rate_limited" | "origin_not_allowed"
	>,
	Route<
		"signIn.magicLink.redeem",
		"/sign-in/magic-link/redeem",
		{
			token: string;
		} & {},
		SignInResult,
		"invalid_input" | "rate_limited" | "origin_not_allowed" | "invalid_token"
	>,
	Route<
		"email.requestVerification",
		"/email/request-verification",
		{} & {},
		void,
		| "invalid_input"
		| "rate_limited"
		| "origin_not_allowed"
		| "account_disabled"
		| "session_required"
	>,
	Route<
		"email.redeemVerification",
		"/email/redeem-verification",
		{
			token: string;
		} & {},
		ChangedUser,
		"invalid_input" | "rate_limited" | "origin_not_allowed" | "invalid_token"
	>,
	Route<
		"email.requestChange",
		"/email/request-change",
		{
			newEmail: string;
		} & {},
		void,
		| "invalid_input"
		| "rate_limited"
		| "origin_not_allowed"
		| "account_disabled"
		| "session_required"
		| "freshness_required"
	>,
	Route<
		"email.redeemChange",
		"/email/redeem-change",
		{
			token: string;
		} & {},
		ChangedUser,
		"invalid_input" | "rate_limited" | "origin_not_allowed" | "invalid_token"
	>,
	Route<
		"password.requestReset",
		"/password/request-reset",
		{
			email: string;
		} & {},
		void,
		"invalid_input" | "rate_limited" | "origin_not_allowed"
	>,
	Route<
		"password.redeemReset",
		"/password/redeem-reset",
		{
			newPassword: string;
			token: string;
		} & {},
		SetPasswordResult,
		| "invalid_input"
		| "rate_limited"
		| "origin_not_allowed"
		| "invalid_token"
		| "password_unacceptable"
	>,
	Route<
		"signIn.password",
		"/sign-in/password",
		{
			username: string;
			email: string;
			password: string;
			emailOrUsername: string;
		} & {},
		SignInResult,
		"invalid_input" | "rate_limited" | "origin_not_allowed" | "invalid_credentials"
	>,
	Route<
		"password.set",
		"/password/set",
		{
			newPassword: string;
		} & {},
		SetPasswordResult,
		| "invalid_input"
		| "rate_limited"
		| "origin_not_allowed"
		| "account_disabled"
		| "session_required"
		| "freshness_required"
		| "password_unacceptable"
		| "factor_already_enrolled"
	>,
	Route<
		"password.change",
		"/password/change",
		{
			newPassword: string;
			currentPassword: string;
		} & {},
		SetPasswordResult,
		| "invalid_input"
		| "rate_limited"
		| "origin_not_allowed"
		| "invalid_credentials"
		| "account_disabled"
		| "session_required"
		| "freshness_required"
		| "password_unacceptable"
	>,
	Route<
		"factor.totp.enroll.start",
		"/factor/totp/enroll/start",
		{} & {},
		TotpEnrollment,
		| "invalid_input"
		| "rate_limited"
		| "origin_not_allowed"
		| "account_disabled"
		| "session_required"
		| "freshness_required"
		| "factor_already_enrolled"
	>,
	Route<
		"factor.totp.enroll.finish",
		"/factor/totp/enroll/finish",
		{
			code: string;
		} & {},
		void,
		| "invalid_input"
		| "rate_limited"
		| "origin_not_allowed"
		| "account_disabled"
		| "session_required"
		| "freshness_required"
		| "invalid_factor_code"
		| "factor_not_enrolled"
		| "factor_already_enrolled"
	>,
	Route<
		"factor.totp.verify",
		"/factor/totp/verify",
		{
			code: string;
		} & {},
		SignInResult,
		| "invalid_input"
		| "rate_limited"
		| "origin_not_allowed"
		| "invalid_factor_code"
		| "invalid_pending_authentication"
		| "too_many_factor_attempts"
	>,
	Route<
		"factor.totp.remove",
		"/factor/totp/remove",
		{
			code: string;
		} & {},
		void,
		| "invalid_input"
		| "rate_limited"
		| "origin_not_allowed"
		| "account_disabled"
		| "session_required"
		| "freshness_required"
		| "invalid_factor_code"
		| "factor_not_enrolled"
	>,
	Route<
		"factor.recovery.generate",
		"/factor/recovery/generate",
		{} & {},
		{
			codes: readonly string[];
		},
		| "invalid_input"
		| "rate_limited"
		| "origin_not_allowed"
		| "account_disabled"
		| "session_required"
		| "freshness_required"
	>,
	Route<
		"factor.recovery.verify",
		"/factor/recovery/verify",
		{
			code: string;
		} & {},
		SignInResult,
		| "invalid_input"
		| "rate_limited"
		| "origin_not_allowed"
		| "invalid_recovery_code"
		| "invalid_pending_authentication"
		| "too_many_factor_attempts"
	>,
	Route<
		"factor.recovery.remaining",
		"/factor/recovery/remaining",
		{} & {},
		{
			remainingCount: number;
		},
		"rate_limited" | "origin_not_allowed" | "account_disabled" | "session_required"
	>,
	Route<
		"factor.webauthn.register.start",
		"/factor/webauthn/register/start",
		{} & {},
		WebAuthnRegistrationChallenge,
		| "invalid_input"
		| "rate_limited"
		| "origin_not_allowed"
		| "account_disabled"
		| "session_required"
		| "freshness_required"
	>,
	Route<
		"factor.webauthn.register.finish",
		"/factor/webauthn/register/finish",
		{
			challengeToken: string;
			response: Record<string, unknown>;
			label: string;
		} & {},
		{
			credential: WebAuthnCredential;
		},
		| "invalid_input"
		| "rate_limited"
		| "origin_not_allowed"
		| "account_disabled"
		| "session_required"
		| "freshness_required"
		| "webauthn_challenge_invalid"
		| "webauthn_credential_rejected"
	>,
	Route<
		"factor.webauthn.authenticate.start",
		"/factor/webauthn/authenticate/start",
		{} & {},
		WebAuthnAuthenticationChallenge,
		| "invalid_input"
		| "rate_limited"
		| "origin_not_allowed"
		| "invalid_pending_authentication"
		| "factor_not_enrolled"
	>,
	Route<
		"factor.webauthn.authenticate.finish",
		"/factor/webauthn/authenticate/finish",
		{
			challengeToken: string;
			response: Record<string, unknown>;
		} & {},
		SignInResult,
		| "invalid_input"
		| "rate_limited"
		| "origin_not_allowed"
		| "invalid_pending_authentication"
		| "too_many_factor_attempts"
		| "webauthn_challenge_invalid"
		| "webauthn_credential_rejected"
	>,
	Route<
		"factor.webauthn.list",
		"/factor/webauthn/list",
		{} & {},
		WebAuthnCredential[],
		"rate_limited" | "origin_not_allowed" | "account_disabled" | "session_required"
	>,
	Route<
		"factor.webauthn.rename",
		"/factor/webauthn/rename",
		{
			label: string;
			credentialId: string;
		} & {},
		{
			credential: WebAuthnCredential;
		},
		| "invalid_input"
		| "rate_limited"
		| "origin_not_allowed"
		| "account_disabled"
		| "session_required"
	>,
	Route<
		"factor.webauthn.remove",
		"/factor/webauthn/remove",
		{
			credentialId: string;
		} & {},
		void,
		| "invalid_input"
		| "rate_limited"
		| "origin_not_allowed"
		| "account_disabled"
		| "session_required"
		| "freshness_required"
		| "last_sign_in_method"
	>,
	Route<
		"signIn.passkey.start",
		"/sign-in/passkey/start",
		{} & {},
		WebAuthnAuthenticationChallenge,
		"invalid_input" | "rate_limited" | "origin_not_allowed"
	>,
	Route<
		"signIn.passkey.finish",
		"/sign-in/passkey/finish",
		{
			challengeToken: string;
			response: Record<string, unknown>;
		} & {},
		SignInResult,
		| "invalid_input"
		| "rate_limited"
		| "origin_not_allowed"
		| "webauthn_challenge_invalid"
		| "webauthn_credential_rejected"
	>,
];

/** what a call needs from its own route row, with no handler reachable from it */
export interface ClientRoute {
	readonly name: string;
	readonly method: HttpMethod;
	readonly path: string;
}

type ClientRouteOf<Declared> = Declared extends {
	readonly name: infer Name;
	readonly path: infer Path;
}
	? { readonly name: Name; readonly method: HttpMethod; readonly path: Path }
	: never;

type ClientRoutesOf<Routes extends readonly AnyRoute[]> = {
	readonly [Index in keyof Routes]: ClientRouteOf<Routes[Index]>;
};

/** the route table as a value, carrying no import of the module that declares the server routes */
export const VELVE_CLIENT_ROUTES = [
	{ name: "signOut", method: "POST", path: "/sign-out" },
	{ name: "session.read", method: "GET", path: "/session" },
	{ name: "session.list", method: "GET", path: "/session/list" },
	{ name: "session.revoke", method: "POST", path: "/session/revoke" },
	{ name: "session.revokeAllOther", method: "POST", path: "/session/revoke-others" },
	{ name: "session.revokeAll", method: "POST", path: "/session/revoke-all" },
	{ name: "session.refresh", method: "POST", path: "/session/refresh" },
	{ name: "username.isAvailable", method: "GET", path: "/username/available" },
	{ name: "username.change", method: "POST", path: "/username/change" },
	{ name: "pending.read", method: "GET", path: "/pending" },
	{ name: "pending.cancel", method: "POST", path: "/pending/cancel" },
	{ name: "signIn.oauth.start", method: "POST", path: "/sign-in/oauth/start" },
	{ name: "signIn.oauth.callback", method: "GET", path: "/sign-in/oauth/callback/:provider" },
	{
		name: "signIn.oauth.callbackFormPost",
		method: "POST",
		path: "/sign-in/oauth/callback/:provider",
	},
	{ name: "identity.list", method: "GET", path: "/identity/list" },
	{ name: "identity.link.start", method: "POST", path: "/identity/link/start" },
	{ name: "identity.unlink", method: "POST", path: "/identity/unlink" },
	{ name: "signUp.withPassword", method: "POST", path: "/sign-up" },
	{ name: "signUp.withoutPassword", method: "POST", path: "/sign-up/passwordless" },
	{
		name: "password.redeemResetWithRecoveryCode",
		method: "POST",
		path: "/password/redeem-reset-with-recovery-code",
	},
	{ name: "signIn.magicLink.request", method: "POST", path: "/sign-in/magic-link/request" },
	{ name: "signIn.magicLink.redeem", method: "POST", path: "/sign-in/magic-link/redeem" },
	{ name: "email.requestVerification", method: "POST", path: "/email/request-verification" },
	{ name: "email.redeemVerification", method: "POST", path: "/email/redeem-verification" },
	{ name: "email.requestChange", method: "POST", path: "/email/request-change" },
	{ name: "email.redeemChange", method: "POST", path: "/email/redeem-change" },
	{ name: "password.requestReset", method: "POST", path: "/password/request-reset" },
	{ name: "password.redeemReset", method: "POST", path: "/password/redeem-reset" },
	{ name: "signIn.password", method: "POST", path: "/sign-in/password" },
	{ name: "password.set", method: "POST", path: "/password/set" },
	{ name: "password.change", method: "POST", path: "/password/change" },
	{ name: "factor.totp.enroll.start", method: "POST", path: "/factor/totp/enroll/start" },
	{ name: "factor.totp.enroll.finish", method: "POST", path: "/factor/totp/enroll/finish" },
	{ name: "factor.totp.verify", method: "POST", path: "/factor/totp/verify" },
	{ name: "factor.totp.remove", method: "POST", path: "/factor/totp/remove" },
	{ name: "factor.recovery.generate", method: "POST", path: "/factor/recovery/generate" },
	{ name: "factor.recovery.verify", method: "POST", path: "/factor/recovery/verify" },
	{ name: "factor.recovery.remaining", method: "GET", path: "/factor/recovery/remaining" },
	{
		name: "factor.webauthn.register.start",
		method: "POST",
		path: "/factor/webauthn/register/start",
	},
	{
		name: "factor.webauthn.register.finish",
		method: "POST",
		path: "/factor/webauthn/register/finish",
	},
	{
		name: "factor.webauthn.authenticate.start",
		method: "POST",
		path: "/factor/webauthn/authenticate/start",
	},
	{
		name: "factor.webauthn.authenticate.finish",
		method: "POST",
		path: "/factor/webauthn/authenticate/finish",
	},
	{ name: "factor.webauthn.list", method: "GET", path: "/factor/webauthn/list" },
	{ name: "factor.webauthn.rename", method: "POST", path: "/factor/webauthn/rename" },
	{ name: "factor.webauthn.remove", method: "POST", path: "/factor/webauthn/remove" },
	{ name: "signIn.passkey.start", method: "POST", path: "/sign-in/passkey/start" },
	{ name: "signIn.passkey.finish", method: "POST", path: "/sign-in/passkey/finish" },
] as const satisfies ClientRoutesOf<VelveRouteTable>;
