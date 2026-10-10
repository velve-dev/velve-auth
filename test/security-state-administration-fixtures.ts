import { randomBytes } from "node:crypto";
import type { Driver } from "../src/core/db/driver.js";
import { encryptWithPurposeKey } from "../src/core/keys/envelope.js";
import { decryptBound } from "../src/core/keys/envelope-binding.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import type { SecurityStateAnchor } from "../src/core/plugin/config.js";
import type { SecurityStateFloor, SecurityStateSealedEvent } from "../src/index.js";

//an account from before 2.0.0 has old-form envelopes and no seal row (S-INTEG-8)

/** the password ciphertext of an account in plaintext, opened in the bound form the library wrote */
export async function passwordPlaintextOf(
	driver: Driver,
	schema: string,
	keys: KeyProvider,
	userId: string,
): Promise<Uint8Array<ArrayBuffer>> {
	const [row] = await driver.query<{ phc: Uint8Array; key_version: number }>(
		`SELECT phc, key_version FROM ${schema}.password_credential WHERE user_id = $1`,
		[userId],
	);
	if (row === undefined) {
		throw new Error("the account has no password");
	}
	return decryptBound(
		keys,
		{ column: "password_credential.phc", owner: userId, row: userId },
		{ keyVersion: Number(row.key_version), ciphertext: Uint8Array.from(row.phc) },
		"refused",
	);
}

/** whether a ciphertext of an account opens in the bound form, which an old-form one never does */
export async function opensBound(
	keys: KeyProvider,
	column: "password_credential.phc" | "totp_credential.secret_enc",
	userId: string,
	stored: { readonly keyVersion: number; readonly ciphertext: Uint8Array },
): Promise<Uint8Array<ArrayBuffer> | null> {
	try {
		return await decryptBound(
			keys,
			{ column, owner: userId, row: userId },
			{ keyVersion: stored.keyVersion, ciphertext: Uint8Array.from(stored.ciphertext) },
			"refused",
		);
	} catch {
		return null;
	}
}

/** turns a signed-up account back into the form it had before the upgrade */
export async function toPreUpgradeForm(
	driver: Driver,
	schema: string,
	keys: KeyProvider,
	userId: string,
): Promise<void> {
	const plaintext = await passwordPlaintextOf(driver, schema, keys, userId);
	const old = await encryptWithPurposeKey(keys, "password-enc", plaintext);
	await driver.query(
		`UPDATE ${schema}.password_credential SET phc = $2, key_version = $3 WHERE user_id = $1`,
		[userId, old.ciphertext, old.keyVersion],
	);
	const [totp] = await driver.query<{ secret_enc: Uint8Array; key_version: number }>(
		`SELECT secret_enc, key_version FROM ${schema}.totp_credential WHERE user_id = $1`,
		[userId],
	);
	if (totp !== undefined) {
		const secret = await decryptBound(
			keys,
			{ column: "totp_credential.secret_enc", owner: userId, row: userId },
			{ keyVersion: Number(totp.key_version), ciphertext: Uint8Array.from(totp.secret_enc) },
			"refused",
		);
		const oldSecret = await encryptWithPurposeKey(keys, "totp-enc", secret);
		await driver.query(
			`UPDATE ${schema}.totp_credential SET secret_enc = $2, key_version = $3 WHERE user_id = $1`,
			[userId, oldSecret.ciphertext, oldSecret.keyVersion],
		);
	}
	await driver.query(`DELETE FROM ${schema}.security_state WHERE user_id = $1`, [userId]);
}

/** an account written by SQL as 1.x wrote it, with the given password and an optional TOTP secret */
export async function insertPreUpgradeAccount(
	driver: Driver,
	schema: string,
	keys: KeyProvider,
	input: {
		readonly id: string;
		readonly phc: Uint8Array<ArrayBuffer>;
		readonly totpSecret?: Uint8Array<ArrayBuffer>;
	},
): Promise<void> {
	await driver.query(`INSERT INTO ${schema}.user (id, email) VALUES ($1, $2)`, [
		input.id,
		`${randomBytes(8).toString("hex")}@example.com`,
	]);
	const password = await encryptWithPurposeKey(keys, "password-enc", input.phc);
	await driver.query(
		`INSERT INTO ${schema}.password_credential (user_id, phc, key_version, scheme)
VALUES ($1, $2, $3, 'argon2id')`,
		[input.id, password.ciphertext, password.keyVersion],
	);
	if (input.totpSecret !== undefined) {
		const secret = await encryptWithPurposeKey(keys, "totp-enc", input.totpSecret);
		await driver.query(
			`INSERT INTO ${schema}.totp_credential (user_id, secret_enc, key_version, confirmed_at)
VALUES ($1, $2, $3, now())`,
			[input.id, secret.ciphertext, secret.keyVersion],
		);
	}
}

/** the anchor an application keeps outside the velve schema, held in memory for the test */
export interface MemoryAnchor {
	readonly anchor: SecurityStateAnchor;
	readonly recorded: readonly SecurityStateSealedEvent[];
	/** how many times recordSeal reported a version the anchor already held with another digest */
	readonly conflicts: number;
	/** runs once, inside the next minimumVersion call for the account, after its answer is taken */
	beforeNextAnswer(userId: string, work: () => Promise<void>): void;
}

export function memoryAnchor(): MemoryAnchor {
	const recorded: SecurityStateSealedEvent[] = [];
	const highest = new Map<string, SecurityStateFloor>();
	const pending = new Map<string, () => Promise<void>>();
	let conflicts = 0;
	return {
		anchor: {
			recordSeal(event) {
				recorded.push(event);
				const held = recorded.find(
					(earlier) =>
						earlier !== event &&
						earlier.userId === event.userId &&
						earlier.version === event.version &&
						earlier.digest !== event.digest,
				);
				if (held !== undefined) {
					conflicts += 1;
				}
				const current = highest.get(event.userId);
				if (current === undefined || event.version > current.version) {
					highest.set(event.userId, { version: event.version, digest: event.digest });
				}
				return Promise.resolve();
			},
			async minimumVersion({ userId }) {
				const answer = highest.get(userId) ?? null;
				const work = pending.get(userId);
				if (work !== undefined) {
					pending.delete(userId);
					await work();
				}
				return answer;
			},
		},
		get recorded() {
			return recorded;
		},
		get conflicts() {
			return conflicts;
		},
		beforeNextAnswer(userId, work) {
			pending.set(userId, work);
		},
	};
}

/** a driver that runs `before` ahead of every statement `matches` picks, inside or outside a transaction */
export function interceptingDriver(
	inner: Driver,
	matches: (sql: string) => boolean,
	before: (sql: string, params: readonly unknown[]) => Promise<void>,
): Driver {
	const wrap = (driver: Driver): Driver => ({
		async query<R>(sql: string, params: unknown[]): Promise<R[]> {
			if (matches(sql)) {
				await before(sql, params);
			}
			return driver.query<R>(sql, params);
		},
		transaction: <R>(work: (tx: Driver) => Promise<R>): Promise<R> =>
			driver.transaction((tx) => work(wrap(tx))),
	});
	return wrap(inner);
}
