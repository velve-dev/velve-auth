export const KEY_PURPOSES = [
	"cookie-sig",
	"token-pepper",
	"totp-enc",
	"oauth-token-enc",
	"pkce-enc",
	"password-enc",
] as const;

export type KeyPurpose = (typeof KEY_PURPOSES)[number];

export type EncryptionKeyPurpose = Extract<KeyPurpose, `${string}-enc`>;

export type SigningKeyPurpose = Exclude<KeyPurpose, EncryptionKeyPurpose>;

const ENCRYPTION_PURPOSE_NAME = /-enc$/;

//one function answers whether a purpose encrypts so ring and envelope cannot disagree (E-70)
export function isEncryptionPurpose(purpose: KeyPurpose): purpose is EncryptionKeyPurpose {
	return ENCRYPTION_PURPOSE_NAME.test(purpose);
}
