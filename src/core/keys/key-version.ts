// A key version has to fit `password_credential.key_version` and `recovery_code.key_version`,
// which are PostgreSQL `integer` columns (L-2, L-3), so the envelope encodes the same range.
export const MAXIMUM_KEY_VERSION = 2_147_483_647;

export function isStorableKeyVersion(version: number): boolean {
	return Number.isInteger(version) && version >= 1 && version <= MAXIMUM_KEY_VERSION;
}
