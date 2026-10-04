import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import type { CHash } from "@noble/hashes/utils.js";
import { pbkdf2CostIsAcceptable } from "../limits.js";
import { integerParameter, type PhcString } from "../phc.js";
import type { AcceptedPassword } from "../policy.js";
import { asDerivedKey, derivedKeysAreEqual } from "../secret.js";

const ASYNC_TICK_IN_MILLISECONDS = 10;

//a Map keeps an imported digest id off Object.prototype (E-178)
const DIGEST_BY_ID = new Map<string, { subtle: "SHA-256" | "SHA-512"; noble: CHash }>([
	["pbkdf2-sha256", { subtle: "SHA-256", noble: sha256 }],
	["pbkdf2-sha512", { subtle: "SHA-512", noble: sha512 }],
]);

interface Pbkdf2Inputs {
	readonly digest: { subtle: "SHA-256" | "SHA-512"; noble: CHash };
	readonly iterations: number;
	readonly salt: Uint8Array<ArrayBuffer>;
	readonly expected: Uint8Array<ArrayBuffer>;
}

export function readPbkdf2(stored: PhcString): Pbkdf2Inputs | null {
	const digest = DIGEST_BY_ID.get(stored.id);
	const iterations = integerParameter(stored, "i");

	if (
		digest === undefined ||
		iterations === null ||
		!pbkdf2CostIsAcceptable(iterations) ||
		stored.salt === undefined ||
		stored.hash === undefined
	) {
		return null;
	}

	return { digest, iterations, salt: stored.salt, expected: stored.hash };
}

export async function verifyPbkdf2(
	password: AcceptedPassword,
	stored: PhcString,
): Promise<boolean> {
	const inputs = readPbkdf2(stored);
	if (inputs === null) {
		return false;
	}

	const derived =
		(await subtlePbkdf2(
			inputs.digest.subtle,
			password.bytes,
			inputs.salt,
			inputs.iterations,
			inputs.expected.length,
		)) ??
		(await pbkdf2Async(inputs.digest.noble, password.bytes, inputs.salt, {
			c: inputs.iterations,
			dkLen: inputs.expected.length,
			asyncTick: ASYNC_TICK_IN_MILLISECONDS,
		}));

	return derivedKeysAreEqual(asDerivedKey(derived), asDerivedKey(inputs.expected));
}

//no WASM is used for PBKDF2 as it measured 2.3 times slower here
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
