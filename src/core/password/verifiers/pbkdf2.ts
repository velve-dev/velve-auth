import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import type { CHash } from "@noble/hashes/utils.js";
import { integerParameter, type PhcString } from "../phc.js";
import type { AcceptedPassword } from "../policy.js";
import { asDerivedKey, derivedKeysAreEqual } from "../secret.js";

const ASYNC_TICK_IN_MILLISECONDS = 10;

const DIGEST_BY_ID: Readonly<
	Record<string, { readonly subtle: "SHA-256" | "SHA-512"; readonly noble: CHash }>
> = {
	"pbkdf2-sha256": { subtle: "SHA-256", noble: sha256 },
	"pbkdf2-sha512": { subtle: "SHA-512", noble: sha512 },
};

/** `$pbkdf2-sha256$i=<iterations>$<salt>$<hash>` — the form the Clerk and Auth0 imports write. */
export async function verifyPbkdf2(
	password: AcceptedPassword,
	stored: PhcString,
): Promise<boolean> {
	const digest = DIGEST_BY_ID[stored.id];
	const iterations = integerParameter(stored, "i");

	if (
		digest === undefined ||
		iterations === null ||
		iterations < 1 ||
		stored.salt === undefined ||
		stored.hash === undefined
	) {
		return false;
	}

	const derived =
		(await subtlePbkdf2(
			digest.subtle,
			password.bytes,
			stored.salt,
			iterations,
			stored.hash.length,
		)) ??
		(await pbkdf2Async(digest.noble, password.bytes, stored.salt, {
			c: iterations,
			dkLen: stored.hash.length,
			asyncTick: ASYNC_TICK_IN_MILLISECONDS,
		}));

	return derivedKeysAreEqual(asDerivedKey(derived), asDerivedKey(stored.hash));
}

// 2.7 names `crypto.subtle.deriveBits` first and `@noble/hashes/pbkdf2` as the fallback; WASM is
// 2.3 times slower here and is deliberately not used.
async function subtlePbkdf2(
	hash: "SHA-256" | "SHA-512",
	password: Uint8Array<ArrayBuffer>,
	salt: Uint8Array<ArrayBuffer>,
	iterations: number,
	hashBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
	try {
		const key = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);

		return new Uint8Array(
			await crypto.subtle.deriveBits(
				{ name: "PBKDF2", salt, iterations, hash },
				key,
				hashBytes * 8,
			),
		);
	} catch {
		return null;
	}
}
