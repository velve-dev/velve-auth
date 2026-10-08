import type { Driver } from "../db/driver.js";
import { qualifiedTableName } from "../db/identifier.js";
import { KEY_PURPOSES, type KeyProvider } from "../keys/index.js";
import { keyTakesMac, sameKeyFingerprintOf } from "../keys/mac.js";
import { storedIntegrityKeyUnusable, storedStateMacKeySharedWith } from "./startup.js";

//a version no seal row names is never read and needs no probe (E-3191)
export async function assertStoredIntegrityKeysTakeMac(options: {
	readonly driver: Driver;
	readonly keys: KeyProvider;
	readonly schema: string;
}): Promise<void> {
	const rows = await options.driver.query<{ key_version: number }>(
		`SELECT DISTINCT key_version FROM ${qualifiedTableName(options.schema, "security_state")}
		ORDER BY key_version`,
		[],
	);
	const currentPurposeByFingerprint = await currentPurposesByFingerprint(options.keys);
	for (const row of rows) {
		const key = await options.keys.byVersion("state-mac", row.key_version);
		//a version that left the ring is a broken state of those accounts and not a start error (E-3191)
		if (key === null) {
			continue;
		}
		if (!(await keyTakesMac(key))) {
			throw storedIntegrityKeyUnusable(row.key_version);
		}
		const fingerprint = await sameKeyFingerprintOf(key);
		const sharedWith =
			fingerprint === null ? undefined : currentPurposeByFingerprint.get(fingerprint);
		if (sharedWith !== undefined) {
			throw storedStateMacKeySharedWith(row.key_version, sharedWith);
		}
	}
}

async function currentPurposesByFingerprint(keys: KeyProvider): Promise<Map<string, string>> {
	const byFingerprint = new Map<string, string>();
	for (const purpose of KEY_PURPOSES) {
		if (purpose === "state-mac") {
			continue;
		}
		const fingerprint = await sameKeyFingerprintOf((await keys.current(purpose)).key);
		if (fingerprint !== null) {
			byFingerprint.set(fingerprint, purpose);
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
