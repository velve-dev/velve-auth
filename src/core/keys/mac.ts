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
type MacVerdict = "valid" | "mismatch" | "key_version_unknown" | "key_unusable";

async function hmacUnder(
	key: CryptoKey,
	message: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
}

const MAC_BYTES = 32;

const MINIMUM_KEY_BITS = 256;

interface NamedHashAlgorithm {
	readonly name?: string;
	readonly hash?: { readonly name?: string };
	readonly length?: number;
}

//a key shorter than the derived 32 bytes would carry every seal and token mac (E-3296)
function isHmacSha256OfFullLength(key: CryptoKey): boolean {
	const algorithm: NamedHashAlgorithm = key.algorithm;
	return (
		algorithm.name === "HMAC" &&
		algorithm.hash?.name === "SHA-256" &&
		(algorithm.length ?? 0) >= MINIMUM_KEY_BITS
	);
}

//a provider of its own can hand over a key that signs with another hash or not at all (E-3190)
async function hmacUnderIfUsable(
	key: CryptoKey,
	message: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer> | null> {
	if (!isHmacSha256OfFullLength(key)) {
		return null;
	}
	const mac = await hmacUnder(key, message).catch(() => null);
	return mac?.length === MAC_BYTES ? mac : null;
}

export async function keyTakesMac(key: CryptoKey): Promise<boolean> {
	return (await hmacUnderIfUsable(key, new Uint8Array(0))) !== null;
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
	const mac = await hmacUnderIfUsable(key, message);
	if (mac === null) {
		throw new KeyError("key_unusable");
	}
	return { keyVersion: version, mac };
}

//a stored mac is compared in constant time and never through web crypto verify (E-3088)
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
	const recomputed = await hmacUnderIfUsable(key, message);
	if (recomputed === null) {
		return "key_unusable";
	}
	return equalsInConstantTime(recomputed, stored.mac) ? "valid" : "mismatch";
}
