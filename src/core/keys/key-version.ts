//a key version must fit the PostgreSQL integer columns that store it
export const MAXIMUM_KEY_VERSION = 2_147_483_647;

export function isStorableKeyVersion(version: number): boolean {
	return Number.isInteger(version) && version >= 1 && version <= MAXIMUM_KEY_VERSION;
}
