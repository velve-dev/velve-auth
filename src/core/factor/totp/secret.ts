import { Secret } from "otpauth";
import { randomBytes } from "../../token/random.js";
import {
	TOTP_ALGORITHM,
	TOTP_DIGITS,
	TOTP_PERIOD_SECONDS,
	TOTP_SECRET_BYTES,
} from "./parameters.js";

// S-RAND-1 and S-RAND-5: the secret is drawn where every other secret of the library is drawn.
export function createTotpSecret(): Uint8Array<ArrayBuffer> {
	return randomBytes(TOTP_SECRET_BYTES);
}

export function totpSecretBase32(secretBytes: Uint8Array<ArrayBuffer>): string {
	return new Secret({ buffer: secretBytes.buffer }).base32;
}

export interface TotpEnrollment {
	readonly secretBase32: string;
	readonly otpauthUri: string;
}

/**
 * The key URI format is Google's, not a standard, and the parameters are written out even where
 * they equal its defaults so that an authenticator which changed a default cannot silently disagree.
 */
export function totpEnrollment(input: {
	readonly secretBytes: Uint8Array<ArrayBuffer>;
	readonly issuer: string;
	readonly accountName: string;
}): TotpEnrollment {
	const secretBase32 = totpSecretBase32(input.secretBytes);
	const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.accountName)}`;
	const parameters = new URLSearchParams({
		secret: secretBase32,
		issuer: input.issuer,
		algorithm: TOTP_ALGORITHM,
		digits: String(TOTP_DIGITS),
		period: String(TOTP_PERIOD_SECONDS),
	});

	return { secretBase32, otpauthUri: `otpauth://totp/${label}?${parameters.toString()}` };
}
