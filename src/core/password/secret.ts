import { equalsInConstantTime } from "../keys/index.js";

declare const SECRET_BRAND: unique symbol;

/**
 * Key material that must never reach `===`, `startsWith`, `includes` or `localeCompare`; the brand
 * is what makes that statically checkable (S-TIM-3).
 */
export type Secret<Name extends string> = Uint8Array<ArrayBuffer> & {
	readonly [SECRET_BRAND]: Name;
};

export type DerivedKey = Secret<"derived-key">;

export function asDerivedKey(bytes: Uint8Array<ArrayBuffer>): DerivedKey {
	return bytes as DerivedKey;
}

/** The only comparison the module makes on a derived key, and it is over equal-length buffers. */
export function derivedKeysAreEqual(left: DerivedKey, right: DerivedKey): boolean {
	return equalsInConstantTime(left, right);
}
