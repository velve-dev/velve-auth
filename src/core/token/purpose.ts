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

/**
 * Who an artefact is for. A request that names no account still says what it is about, because the
 * serialisation S-TOKEN-3 needs and the uniformity 5.3 (a) needs are one lock: a request that
 * waited on nothing where a request for an account waits on the account is an existence oracle with
 * a stopwatch on it (E-931).
 */
export type OneTimeTokenSubject =
	| { readonly userId: string; readonly serialisedOn?: undefined }
	| { readonly userId: null; readonly serialisedOn: string };
