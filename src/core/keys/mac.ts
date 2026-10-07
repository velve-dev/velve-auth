import { equalsInConstantTime } from "./constant-time.js";
import { KeyError } from "./errors.js";
import { isStorableKeyVersion } from "./key-version.js";
import type { KeyProvider } from "./provider.js";
import type { IntegrityKeyPurpose } from "./purpose.js";

/** a MAC together with the key version it was taken under, which is stored beside it */
interface VersionedMac {
	readonly keyVersion: number;
	readonly mac: Uint8Array<ArrayBuffer>;
}

/** what checking a stored MAC found, where an unknown version is told apart from a mismatch */
type MacVerdict = "valid" | "mismatch" | "key_version_unknown";

async function hmacUnder(
	key: CryptoKey,
	message: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
}

export async function macUnderCurrentKey(
	keys: KeyProvider,
	purpose: IntegrityKeyPurpose,
	message: Uint8Array<ArrayBuffer>,
): Promise<VersionedMac> {
	const { version, key } = await keys.current(purpose);
	if (!isStorableKeyVersion(version)) {
		throw new KeyError("key_version_out_of_range");
	}
	return { keyVersion: version, mac: await hmacUnder(key, message) };
}

//web crypto promises no constant time for verify so the comparison is made here (S-INTEG-2)
export async function verifyMacUnderKeyVersion(
	keys: KeyProvider,
	purpose: IntegrityKeyPurpose,
	stored: VersionedMac,
	message: Uint8Array<ArrayBuffer>,
): Promise<MacVerdict> {
	const key = isStorableKeyVersion(stored.keyVersion)
		? await keys.byVersion(purpose, stored.keyVersion)
		: null;
	if (key === null) {
		return "key_version_unknown";
	}
	return equalsInConstantTime(await hmacUnder(key, message), stored.mac) ? "valid" : "mismatch";
}
