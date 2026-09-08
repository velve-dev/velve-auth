export const ONE_TIME_TOKEN_PURPOSES = [
	"email_verify",
	"password_reset",
	"email_change",
	"magic_link",
] as const;

export type OneTimeTokenPurpose = (typeof ONE_TIME_TOKEN_PURPOSES)[number];

export type OneTimeTokenPayload = Readonly<Record<string, unknown>>;

const HOUR_IN_SECONDS = 60 * 60;

// Section 3.7, last paragraph.
export const ONE_TIME_TOKEN_LIFETIME_SECONDS: Readonly<Record<OneTimeTokenPurpose, number>> = {
	email_verify: 24 * HOUR_IN_SECONDS,
	password_reset: HOUR_IN_SECONDS,
	email_change: HOUR_IN_SECONDS,
	magic_link: 10 * 60,
};
