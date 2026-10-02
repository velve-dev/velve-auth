/** the eight events that issue a new token and leave no row of the old trust level standing */
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

/** whether each event revokes the account's other sessions as well as re-issuing its own */
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
