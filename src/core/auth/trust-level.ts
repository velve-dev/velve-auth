/**
 * S-FIX-1 and T-FIX-1: the eight events after which the previous session row is gone and a new
 * token has been issued. The list is a constant rather than eight scattered call sites because
 * T-FIX-1 is table-driven from it — a ninth event added without a case here fails the count, and
 * a case removed fails it too.
 */
export const TRUST_LEVEL_EVENTS = [
	"sign_in_password",
	"sign_in_passkey",
	"second_factor_totp",
	"second_factor_webauthn",
	"second_factor_recovery_code",
	"password_change",
	"password_reset",
	"identity_linked",
] as const;

export type TrustLevelEvent = (typeof TRUST_LEVEL_EVENTS)[number];

/**
 * Which re-issue each event owes, spelled out because E-243 records that the two have the same
 * shape and different effect: a password change that reaches for `reissue` satisfies S-FIX-1 and
 * loses S-FIX-6, and nothing in the session module can notice.
 */
export const TRUST_LEVEL_EVENT_REVOKES_OTHER_SESSIONS: Readonly<Record<TrustLevelEvent, boolean>> =
	{
		sign_in_password: false,
		sign_in_passkey: false,
		second_factor_totp: false,
		second_factor_webauthn: false,
		second_factor_recovery_code: false,
		password_change: true,
		password_reset: true,
		identity_linked: false,
	};
