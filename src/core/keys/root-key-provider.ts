import { decodeBase64Url } from "./base64url.js";
import { KeyError } from "./errors.js";
import { derivePurposeKeyBytes } from "./hkdf.js";
import { isStorableKeyVersion } from "./key-version.js";
import type { KeyProvider } from "./provider.js";
import type { KeyPurpose } from "./purpose.js";

const MINIMUM_ROOT_KEY_BYTES = 32;
const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;

const ENCRYPTION_PURPOSES = new Set<KeyPurpose>([
	"totp-enc",
	"oauth-token-enc",
	"pkce-enc",
	"password-enc",
]);

export interface RootKeyProviderInput {
	currentVersion: number;
	keysByVersion: Readonly<Record<number, string>>;
}

export function rootKeyProvider(input: RootKeyProviderInput): KeyProvider {
	const rootKeysByVersion = decodeRootKeys(input.keysByVersion);
	if (!isStorableKeyVersion(input.currentVersion)) {
		throw new KeyError("key_version_out_of_range");
	}

	// S-KEY-6: a missing or too short root key stops construction, not the first request.
	const currentRootKey = rootKeysByVersion.get(input.currentVersion);
	if (currentRootKey === undefined) {
		throw new KeyError("root_key_missing");
	}

	const purposeKeys = new Map<string, Promise<CryptoKey>>();

	function purposeKey(purpose: KeyPurpose, version: number, rootKey: Uint8Array<ArrayBuffer>) {
		const cached = purposeKeys.get(`${version}/${purpose}`);
		if (cached !== undefined) {
			return cached;
		}

		const pending = derivePurposeKeyBytes(rootKey, purpose).then((keyBytes) =>
			importPurposeKey(purpose, keyBytes),
		);
		purposeKeys.set(`${version}/${purpose}`, pending);
		return pending;
	}

	return {
		async current(purpose) {
			return {
				version: input.currentVersion,
				key: await purposeKey(purpose, input.currentVersion, currentRootKey),
			};
		},

		async byVersion(purpose, version) {
			const rootKey = rootKeysByVersion.get(version);
			if (rootKey === undefined) {
				return null;
			}

			return purposeKey(purpose, version, rootKey);
		},
	};
}

function decodeRootKeys(
	keysByVersion: Readonly<Record<number, string>>,
): Map<number, Uint8Array<ArrayBuffer>> {
	const rootKeysByVersion = new Map<number, Uint8Array<ArrayBuffer>>();

	for (const [version, encodedRootKey] of Object.entries(keysByVersion)) {
		const keyVersion = parseKeyVersion(version);
		if (keyVersion === null) {
			throw new KeyError("key_version_out_of_range");
		}

		const rootKey = decodeBase64Url(encodedRootKey);
		if (rootKey === null) {
			throw new KeyError("root_key_malformed");
		}
		if (rootKey.length < MINIMUM_ROOT_KEY_BYTES) {
			throw new KeyError("root_key_too_short");
		}

		rootKeysByVersion.set(keyVersion, rootKey);
	}

	return rootKeysByVersion;
}

// `Number` would also read "0x10" and "1e2", which no `integer` column can round-trip back.
function parseKeyVersion(text: string): number | null {
	if (!DECIMAL_INTEGER.test(text)) {
		return null;
	}

	const version = Number(text);
	return isStorableKeyVersion(version) ? version : null;
}

// S-KEY-2: signing purposes become HMAC keys and encryption purposes AES-GCM keys, so Web Crypto
// itself rejects a value taken from the wrong purpose.
function importPurposeKey(
	purpose: KeyPurpose,
	keyBytes: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
	if (ENCRYPTION_PURPOSES.has(purpose)) {
		// Extractable because the `@noble/ciphers` fallback needs the raw bytes (E-03).
		return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", true, ["encrypt", "decrypt"]);
	}

	return crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
		"verify",
	]);
}
