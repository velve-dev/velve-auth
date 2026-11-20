import type { ConcealedReason } from "../http/error-map.js";
import { encodeBase64Url } from "../keys/base64url.js";
import { equalsInConstantTime } from "../keys/constant-time.js";
import { KeyError } from "../keys/errors.js";
import { isStorableKeyVersion } from "../keys/key-version.js";
import { keyTakesMac } from "../keys/mac.js";
import type { KeyProvider } from "../keys/provider.js";
import { randomBytes } from "../token/random.js";
import { HIGHEST_PROOF_OF_WORK_DIFFICULTY } from "./config.js";
import { isSolvedAt, LARGEST_PROOF_OF_WORK_NONCE, proofOfWorkInput } from "./work.js";

/** a challenge as the challenge route hands it out, where `challenge` is the value the client hashes */
export interface ProofOfWorkChallenge {
	readonly challenge: string;
	readonly difficulty: number;
	readonly expiresAt: Date;
}

/** how long a challenge can be solved and spent after it was handed out */
export const PROOF_OF_WORK_LIFETIME_IN_SECONDS = 600;

const VALUE_BYTES = 32;
const MILLISECONDS_IN_A_SECOND = 1000;

//a header longer than any challenge the route hands out is refused before it is parsed
const LONGEST_SOLUTION = 160;

const SOLUTION =
	/^(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]?)\.([1-9][0-9]{0,11})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})\.(0|[1-9][0-9]{0,15})$/;

const utf8 = new TextEncoder();

//the challenge key is expanded from cookie-sig so a hand-written key provider answers no new purpose (E-3661)
const CHALLENGE_KEY_INFO = utf8.encode("velve-auth/proof-of-work/v1\u0001");

const MAC_DOMAIN = "velve-auth/proof-of-work/v1";

/** what a presented solution names once it parses, before any of it is believed */
interface ParsedSolution {
	readonly keyVersion: number;
	readonly difficulty: number;
	readonly expiresAtInSeconds: number;
	readonly value: string;
	readonly mac: string;
	readonly challenge: string;
	readonly nonce: number;
}

/** why a presented solution is refused, which only the log ever names */
type ProofOfWorkRefusal = Extract<ConcealedReason, `proof_of_work_${string}`>;

/** a solution whose mac, route and work hold, which is still to be spent before it counts */
export interface CheckedSolution {
	readonly challenge: string;
	readonly expiresAtInSeconds: number;
}

type SolutionCheck =
	| { readonly outcome: "checked"; readonly solution: CheckedSolution }
	| { readonly outcome: "refused"; readonly reason: ProofOfWorkRefusal };

function parsedSolution(presented: string): ParsedSolution | null {
	if (presented.length > LONGEST_SOLUTION) {
		return null;
	}
	const matched = SOLUTION.exec(presented);
	if (matched === null) {
		return null;
	}
	const [, keyVersion, difficulty, expiresAt, value, mac, nonce] = matched;
	const parsed = {
		keyVersion: Number(keyVersion),
		difficulty: Number(difficulty),
		expiresAtInSeconds: Number(expiresAt),
		value: String(value),
		mac: String(mac),
		challenge: presented.slice(0, presented.lastIndexOf(".")),
		nonce: Number(nonce),
	};
	if (
		!isStorableKeyVersion(parsed.keyVersion) ||
		parsed.difficulty > HIGHEST_PROOF_OF_WORK_DIFFICULTY ||
		parsed.nonce > LARGEST_PROOF_OF_WORK_NONCE
	) {
		return null;
	}
	return parsed;
}

//a cookie-sig key that cannot take HMAC-SHA256 must not expand into a challenge key at all
async function challengeKeyUnder(purposeKey: CryptoKey): Promise<CryptoKey> {
	if (!(await keyTakesMac(purposeKey))) {
		throw new KeyError("key_unusable");
	}
	const expanded = await crypto.subtle.sign("HMAC", purposeKey, CHALLENGE_KEY_INFO);
	return crypto.subtle.importKey("raw", expanded, { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
}

function macMessage(route: string, unsigned: string): Uint8Array<ArrayBuffer> {
	return utf8.encode(`${MAC_DOMAIN}\u0000${route}\u0000${unsigned}`);
}

async function macOf(
	key: CryptoKey,
	route: string,
	unsigned: string,
): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(await crypto.subtle.sign("HMAC", key, macMessage(route, unsigned)));
}

/** issues and checks challenges under keys expanded from the key ring, storing nothing */
interface ProofOfWorkChallenges {
	issue(input: {
		readonly route: string;
		readonly difficulty: number;
		readonly expiresAt: Date;
	}): Promise<ProofOfWorkChallenge>;
	check(input: {
		readonly route: string;
		readonly presented: string | null;
	}): Promise<SolutionCheck>;
}

export function createProofOfWorkChallenges(keys: KeyProvider): ProofOfWorkChallenges {
	//a provider that hands back the same key object is expanded once per key and not once per call
	const expandedKeys = new WeakMap<CryptoKey, Promise<CryptoKey>>();
	const challengeKeyOf = (purposeKey: CryptoKey): Promise<CryptoKey> => {
		const cached = expandedKeys.get(purposeKey);
		if (cached !== undefined) {
			return cached;
		}
		const expanding = challengeKeyUnder(purposeKey);
		expandedKeys.set(purposeKey, expanding);
		return expanding;
	};

	return {
		async issue({ route, difficulty, expiresAt }) {
			const { version, key } = await keys.current("cookie-sig");
			if (!isStorableKeyVersion(version)) {
				throw new KeyError("key_version_out_of_range");
			}
			const unsigned = [
				version,
				difficulty,
				Math.floor(expiresAt.getTime() / MILLISECONDS_IN_A_SECOND),
				encodeBase64Url(randomBytes(VALUE_BYTES)),
			].join(".");
			const mac = await macOf(await challengeKeyOf(key), route, unsigned);
			return { challenge: `${unsigned}.${encodeBase64Url(mac)}`, difficulty, expiresAt };
		},

		async check({ route, presented }) {
			if (presented === null) {
				return { outcome: "refused", reason: "proof_of_work_missing" };
			}
			const parsed = parsedSolution(presented);
			if (parsed === null) {
				return { outcome: "refused", reason: "proof_of_work_malformed" };
			}
			const purposeKey = await keys.byVersion("cookie-sig", parsed.keyVersion);
			if (purposeKey === null) {
				return { outcome: "refused", reason: "proof_of_work_forged" };
			}
			const unsigned = [
				parsed.keyVersion,
				parsed.difficulty,
				parsed.expiresAtInSeconds,
				parsed.value,
			].join(".");
			const expected = await macOf(await challengeKeyOf(purposeKey), route, unsigned);
			//a challenge for another route carries a mac over another route name and fails here (S-RATE-9)
			if (!equalsInConstantTime(utf8.encode(encodeBase64Url(expected)), utf8.encode(parsed.mac))) {
				return { outcome: "refused", reason: "proof_of_work_forged" };
			}
			const digest = new Uint8Array(
				await crypto.subtle.digest("SHA-256", proofOfWorkInput(parsed.challenge, parsed.nonce)),
			);
			if (!isSolvedAt(digest, parsed.difficulty)) {
				return { outcome: "refused", reason: "proof_of_work_unsolved" };
			}
			return {
				outcome: "checked",
				solution: {
					challenge: parsed.challenge,
					expiresAtInSeconds: parsed.expiresAtInSeconds,
				},
			};
		},
	};
}
