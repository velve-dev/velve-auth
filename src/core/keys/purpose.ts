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
