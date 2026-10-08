import { macUnderCurrentKey, verifyMacUnderKeyVersion } from "../keys/mac.js";
import type { KeyProvider } from "../keys/provider.js";
import { encodeSecurityState, type SecurityState } from "./encoding.js";

/** a seal digest with the state-mac version it was taken under */
export interface SealDigest {
	readonly keyVersion: number;
	readonly digest: Uint8Array<ArrayBuffer>;
}

/** what checking a stored digest against a state found, each failure named as the alarm names it */
export type SealVerdict = "valid" | "seal_mismatch" | "key_version_unknown" | "key_unusable";

export async function computeSeal(keys: KeyProvider, state: SecurityState): Promise<SealDigest> {
	const { keyVersion, mac } = await macUnderCurrentKey(
		keys,
		"state-mac",
		encodeSecurityState(state),
	);
	return { keyVersion, digest: mac };
}

//the stored digest is compared in constant time under the version stored beside it (S-INTEG-4)
export async function verifySeal(
	keys: KeyProvider,
	state: SecurityState,
	stored: SealDigest,
): Promise<SealVerdict> {
	const verdict = await verifyMacUnderKeyVersion(
		keys,
		"state-mac",
		{ keyVersion: stored.keyVersion, mac: stored.digest },
		encodeSecurityState(state),
	);
	return verdict === "mismatch" ? "seal_mismatch" : verdict;
}
