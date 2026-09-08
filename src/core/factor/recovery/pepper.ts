import type { KeyProvider } from "../../keys/provider.js";
import { normaliseRecoveryCode } from "./code.js";

const utf8 = new TextEncoder();

export interface PepperedRecoveryCode {
	readonly keyVersion: number;
	readonly codeHmac: Uint8Array<ArrayBuffer>;
}

async function hmacUnder(key: CryptoKey, code: string): Promise<Uint8Array<ArrayBuffer>> {
	const signature = await crypto.subtle.sign("HMAC", key, utf8.encode(normaliseRecoveryCode(code)));
	return new Uint8Array(signature);
}

// S-REST-3: a recovery code is stored as HMAC-SHA256 under `token-pepper`, so a database dump alone yields nothing and display is impossible.
export async function pepperRecoveryCode(
	keys: KeyProvider,
	code: string,
): Promise<PepperedRecoveryCode> {
	const { version, key } = await keys.current("token-pepper");
	return { keyVersion: version, codeHmac: await hmacUnder(key, code) };
}

/** L-3: the version travels in `recovery_code.key_version`, so a rotation of `token-pepper` does not void the codes written under the previous one. */
export async function pepperRecoveryCodeUnder(
	keys: KeyProvider,
	keyVersion: number,
	code: string,
): Promise<PepperedRecoveryCode | null> {
	const key = await keys.byVersion("token-pepper", keyVersion);
	if (key === null) {
		return null;
	}
	return { keyVersion, codeHmac: await hmacUnder(key, code) };
}
