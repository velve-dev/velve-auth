import { equalsInConstantTime } from "../keys/index.js";

declare const SECRET_BRAND: unique symbol;

//the brand makes any plain comparison of key material statically checkable (S-TIM-3)
export type Secret<Name extends string> = Uint8Array<ArrayBuffer> & {
	readonly [SECRET_BRAND]: Name;
};

export type DerivedKey = Secret<"derived-key">;

export function asDerivedKey(bytes: Uint8Array<ArrayBuffer>): DerivedKey {
	return bytes as DerivedKey;
}

//a derived key is compared only here and only in constant time (S-TIM-3)
export function derivedKeysAreEqual(left: DerivedKey, right: DerivedKey): boolean {
	return equalsInConstantTime(left, right);
}
