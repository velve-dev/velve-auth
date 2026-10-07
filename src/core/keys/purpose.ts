export const KEY_PURPOSES = [
	"cookie-sig",
	"token-pepper",
	"totp-enc",
	"oauth-token-enc",
	"pkce-enc",
	"password-enc",
	"state-mac",
] as const;

export type KeyPurpose = (typeof KEY_PURPOSES)[number];

export type EncryptionKeyPurpose = Extract<KeyPurpose, `${string}-enc`>;

export type SigningKeyPurpose = Exclude<KeyPurpose, EncryptionKeyPurpose>;

/** a signing purpose whose key only authenticates rows the database must not be able to forge */
export type IntegrityKeyPurpose = Extract<KeyPurpose, `${string}-mac`>;

const ENCRYPTION_PURPOSE_NAME = /-enc$/;

//one function answers whether a purpose encrypts so ring and envelope cannot disagree (E-70)
export function isEncryptionPurpose(purpose: KeyPurpose): purpose is EncryptionKeyPurpose {
	return ENCRYPTION_PURPOSE_NAME.test(purpose);
}
