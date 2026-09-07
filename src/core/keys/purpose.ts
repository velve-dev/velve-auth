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

// The only answer to "does this purpose encrypt", so that adding a seventh purpose cannot leave
// the key ring and the envelope disagreeing about it (E-70).
export function isEncryptionPurpose(purpose: KeyPurpose): purpose is EncryptionKeyPurpose {
	return ENCRYPTION_PURPOSE_NAME.test(purpose);
}
