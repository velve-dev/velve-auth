import { randomBytes as nodeRandomBytes } from "node:crypto";
import type { Driver } from "../src/core/db/driver.js";
import {
	createPendingAuthenticationService,
	type IssuedPendingAuthentication,
	type PendingAuthenticationService,
} from "../src/core/factor/pending/index.js";
import { createTotpSecret } from "../src/core/factor/totp/secret.js";
import { encryptWithPurposeKey } from "../src/core/keys/envelope.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { rootKeyProvider } from "../src/core/keys/root-key-provider.js";

export interface TestKeyRing {
	providerAt(currentVersion: number, availableVersions?: readonly number[]): KeyProvider;
}

/** A rotation test needs two providers over the same root keys, which two independent draws cannot give it. */
export function testKeyRing(versions = 1): TestKeyRing {
	const rootKeys = new Map<number, string>();
	for (let version = 1; version <= versions; version += 1) {
		rootKeys.set(version, nodeRandomBytes(32).toString("base64url"));
	}
	return {
		providerAt(currentVersion, availableVersions) {
			const keysByVersion: Record<number, string> = {};
			for (const version of availableVersions ?? [...rootKeys.keys()]) {
				const rootKey = rootKeys.get(version);
				if (rootKey !== undefined) {
					keysByVersion[version] = rootKey;
				}
			}
			return rootKeyProvider({ currentVersion, keysByVersion });
		},
	};
}

// A test key is drawn per run so that no key material is ever committed (CLAUDE.md section 8).
export function testKeyProvider(currentVersion = 1): KeyProvider {
	return testKeyRing(currentVersion).providerAt(currentVersion);
}

export function pendingAuthenticationsOn(
	driver: Driver,
	schema: string,
): PendingAuthenticationService {
	return createPendingAuthenticationService({ driver, schema });
}

/** The state a second factor is spent on, begun the way the sign-in path begins it. */
export function beginPendingState(
	pending: PendingAuthenticationService,
	userId: string,
	availableFactors: readonly ("totp" | "webauthn" | "recovery")[] = ["totp", "recovery"],
): Promise<IssuedPendingAuthentication> {
	return pending.begin({ userId, factorsCompleted: ["password"], availableFactors });
}

export async function attemptsRecorded(
	driver: Driver,
	schema: string,
	userId: string,
): Promise<number | null> {
	const [row] = await driver.query<{ attempts: number }>(
		`SELECT attempts FROM ${schema}.pending_authentication WHERE user_id = $1`,
		[userId],
	);
	return row?.attempts ?? null;
}

export async function countRows(
	driver: Driver,
	schema: string,
	table: string,
	userId: string,
): Promise<number> {
	const [row] = await driver.query<{ total: number }>(
		`SELECT count(*)::integer AS total FROM ${schema}.${table} WHERE user_id = $1`,
		[userId],
	);
	return row?.total ?? -1;
}

export async function readUsedSteps(
	driver: Driver,
	schema: string,
	userId: string,
): Promise<readonly number[]> {
	const rows = await driver.query<{ time_step: string }>(
		`SELECT time_step FROM ${schema}.totp_used_step WHERE user_id = $1 ORDER BY time_step`,
		[userId],
	);
	return rows.map((row) => Number(row.time_step));
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** The enrolment hands the secret out as base32, and only a test needs it back as bytes. */
export function secretBytesOfBase32(encoded: string): Uint8Array<ArrayBuffer> {
	let bits = 0;
	let accumulator = 0;
	const bytes: number[] = [];
	for (const character of encoded) {
		accumulator = (accumulator << 5) | BASE32_ALPHABET.indexOf(character);
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((accumulator >>> bits) & 0xff);
		}
	}
	return Uint8Array.from(bytes);
}

/**
 * A confirmed credential without going through `enroll.finish`, because that call claims a time
 * step and a race that counts rows in `totp_used_step` has to start from none.
 */
export async function enrolConfirmedCredential(
	driver: Driver,
	schema: string,
	keys: KeyProvider,
	userId: string,
): Promise<Uint8Array<ArrayBuffer>> {
	const secretBytes = createTotpSecret();
	const { keyVersion, ciphertext } = await encryptWithPurposeKey(keys, "totp-enc", secretBytes);
	await driver.query(
		`INSERT INTO ${schema}.totp_credential (user_id, secret_enc, key_version, confirmed_at)
		 VALUES ($1, $2, $3, now())`,
		[userId, ciphertext, keyVersion],
	);
	return secretBytes;
}
