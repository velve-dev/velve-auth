import type { Driver } from "../db/driver.js";
import { qualifiedTableName } from "../db/identifier.js";
import { KEY_PURPOSES, type KeyProvider } from "../keys/index.js";
import { keyTakesMac, sameKeyFingerprintOf } from "../keys/mac.js";
import type { IntegrityKeyPurpose } from "../keys/purpose.js";
import { storedIntegrityKeySharedWith, storedIntegrityKeyUnusable } from "./startup.js";

const TOKEN_TABLES = [
	"session",
	"one_time_token",
	"pending_authentication",
	"webauthn_challenge",
] as const;

//the start must read one index entry per stored version and not every token row
function storedTokenVersionsOf(table: string): string {
	return `SELECT 'token-mac' AS purpose, key_version FROM (
		WITH RECURSIVE stored(key_version) AS (
			(SELECT token_mac_key_version FROM ${table} ORDER BY 1 LIMIT 1)
			UNION ALL
			SELECT (SELECT token_mac_key_version FROM ${table}
				WHERE token_mac_key_version > stored.key_version ORDER BY 1 LIMIT 1)
			FROM stored WHERE stored.key_version IS NOT NULL
		)
		SELECT key_version FROM stored WHERE key_version IS NOT NULL
	) AS versions`;
}

//the seal and the token tables are every place an integrity key version is stored (E-3191)
function storedVersionsStatement(schema: string): string {
	return [
		`SELECT DISTINCT 'state-mac' AS purpose, key_version FROM ${qualifiedTableName(schema, "security_state")}`,
		...TOKEN_TABLES.map((name) => storedTokenVersionsOf(qualifiedTableName(schema, name))),
	]
		.map((part) => `(${part})`)
		.join("\n\tUNION ")
		.concat("\n\tORDER BY 1, 2");
}

//a version no row names is never read and needs no probe (E-3191)
export async function assertStoredIntegrityKeysTakeMac(options: {
	readonly driver: Driver;
	readonly keys: KeyProvider;
	readonly schema: string;
}): Promise<void> {
	const rows = await options.driver.query<{
		purpose: IntegrityKeyPurpose;
		key_version: number;
	}>(storedVersionsStatement(options.schema), []);
	const versionsOf = (purpose: IntegrityKeyPurpose) =>
		rows.filter((row) => row.purpose === purpose).map((row) => row.key_version);
	const otherKeysOf: Record<IntegrityKeyPurpose, Map<string, string>> = {
		"state-mac": await otherPurposeKeysByFingerprint(
			options.keys,
			"state-mac",
			versionsOf("state-mac"),
		),
		"token-mac": await otherPurposeKeysByFingerprint(
			options.keys,
			"token-mac",
			versionsOf("token-mac"),
		),
	};
	for (const row of rows) {
		const key = await options.keys.byVersion(row.purpose, row.key_version);
		//a version that left the ring is a broken state of those accounts and not a start error (E-3191)
		if (key === null) {
			continue;
		}
		if (!(await keyTakesMac(key))) {
			throw storedIntegrityKeyUnusable(row.purpose, row.key_version);
		}
		const fingerprint = await sameKeyFingerprintOf(key);
		const sharedWith = fingerprint === null ? undefined : otherKeysOf[row.purpose].get(fingerprint);
		if (sharedWith !== undefined) {
			throw storedIntegrityKeySharedWith(row.purpose, row.key_version, sharedWith);
		}
	}
}

//an older version of another purpose shares a key as dangerously as its current one (E-3375)
async function otherPurposeKeysByFingerprint(
	keys: KeyProvider,
	stored: IntegrityKeyPurpose,
	storedVersions: readonly number[],
): Promise<Map<string, string>> {
	const byFingerprint = new Map<string, string>();
	const remember = async (key: CryptoKey | null, described: string): Promise<void> => {
		const fingerprint = key === null ? null : await sameKeyFingerprintOf(key);
		if (fingerprint !== null && !byFingerprint.has(fingerprint)) {
			byFingerprint.set(fingerprint, described);
		}
	};
	for (const purpose of KEY_PURPOSES) {
		if (purpose === stored) {
			continue;
		}
		await remember((await keys.current(purpose)).key, `the current ${purpose} key`);
		for (const version of storedVersions) {
			const older = await keys.byVersion(purpose, version).catch(() => null);
			await remember(older, `the ${purpose} key of version ${version}`);
		}
	}
	return byFingerprint;
}

//a schema migration 3 has not reached yet holds no seal whose key could be probed
export async function schemaHoldsTheSealTable(driver: Driver, schema: string): Promise<boolean> {
	const [present] = await driver.query<{ relation: string | null }>(
		"SELECT to_regclass($1)::text AS relation",
		[qualifiedTableName(schema, "security_state")],
	);
	return present?.relation != null;
}
