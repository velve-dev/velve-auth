import { randomBytes as nodeRandomBytes } from "node:crypto";
import type { Driver } from "../src/core/db/driver.js";
import { createTotpSecret } from "../src/core/factor/totp/secret.js";
import type { PendingFactorAttempt } from "../src/core/factor/totp/pending-attempt.js";
import type { Clock } from "../src/core/http/environment.js";
import { encryptWithPurposeKey } from "../src/core/keys/envelope.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { rootKeyProvider } from "../src/core/keys/root-key-provider.js";

export interface SettableClock extends Clock {
	set(instant: Date): void;
	advanceSeconds(seconds: number): void;
}

/**
 * Architecture 6.19 wants this in `@velve/auth/testing`, which is `export {};` today. It lives
 * here until that module exists, because `src/testing/index.ts` belongs to no feature of wave 3.
 */
export function settableClock(instant: Date): SettableClock {
	let current = instant;
	return {
		now: () => current,
		set: (next) => {
			current = next;
		},
		advanceSeconds: (seconds) => {
			current = new Date(current.getTime() + seconds * 1000);
		},
	};
}

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

export interface PendingStateFixture extends PendingFactorAttempt {
	readonly tokenHash: Uint8Array;
	attemptsRecorded(): Promise<number | null>;
}

/**
 * The pending state belongs to `auth-core`, which had published nothing when this was written.
 * This is the shape L-8 asks of it: the counter is raised with `UPDATE … RETURNING` rather than a
 * row lock, because `pnpm check:lock-order` accepts a row lock only on `velve.user`.
 */
export async function createPendingState(
	driver: Driver,
	schema: string,
	userId: string,
	lifetimeSeconds = 300,
): Promise<PendingStateFixture> {
	const tokenHash = nodeRandomBytes(32);
	await driver.query(
		`INSERT INTO ${schema}.pending_authentication
		 (token_sha256, user_id, factors_completed, expires_at)
		 VALUES ($1, $2, '{password}', now() + make_interval(secs => $3::double precision))`,
		[tokenHash, userId, lifetimeSeconds],
	);

	return {
		userId,
		tokenHash,

		async spendAttempt() {
			const [row] = await driver.query<{ attempts: number }>(
				`UPDATE ${schema}.pending_authentication SET attempts = attempts + 1
				 WHERE token_sha256 = $1 AND expires_at > now()
				 RETURNING attempts`,
				[tokenHash],
			);
			return row?.attempts ?? null;
		},

		async discard() {
			await driver.query(
				`DELETE FROM ${schema}.pending_authentication WHERE token_sha256 = $1`,
				[tokenHash],
			);
		},

		async attemptsRecorded() {
			const [row] = await driver.query<{ attempts: number }>(
				`SELECT attempts FROM ${schema}.pending_authentication WHERE token_sha256 = $1`,
				[tokenHash],
			);
			return row?.attempts ?? null;
		},
	};
}

export interface CountingAttempt extends PendingFactorAttempt {
	readonly spent: readonly number[];
	readonly discarded: () => number;
}

export function countingAttempt(userId: string, attemptsAlreadySpent = 0): CountingAttempt {
	const spent: number[] = [];
	let discards = 0;
	let counter = attemptsAlreadySpent;
	return {
		userId,
		spent,
		discarded: () => discards,
		spendAttempt: async () => {
			counter += 1;
			spent.push(counter);
			return counter;
		},
		discard: async () => {
			discards += 1;
		},
	};
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
