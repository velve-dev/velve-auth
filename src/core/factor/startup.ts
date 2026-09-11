import type { Driver } from "../db/driver.js";
import { assertSchemaName, qualifiedTableName } from "../db/identifier.js";
import type { KeyProvider, KeyPurpose } from "../keys/index.js";

export interface StoredFactorKeyVersions {
	readonly purpose: KeyPurpose;
	readonly table: string;
	readonly missingVersions: readonly number[];
}

export class FactorKeyRingError extends Error {
	readonly code = "stored_key_version_unknown";
	readonly missing: readonly StoredFactorKeyVersions[];

	constructor(missing: readonly StoredFactorKeyVersions[]) {
		super(
			missing
				.map(
					(entry) =>
						`stored ${entry.table} rows name ${entry.purpose} key version ` +
						`${entry.missingVersions.join(", ")}, which the key ring does not hold`,
				)
				.join("; "),
		);
		this.name = "FactorKeyRingError";
		this.missing = missing;
	}
}

export interface FactorKeyVersionCheckOptions {
	readonly driver: Driver;
	readonly keys: KeyProvider;
	readonly schema?: string;
}

/**
 * The two second-factor tables that carry a key version: `totp_credential.key_version` names
 * `totp-enc` (S-KEY-3) and `recovery_code.key_version` names `token-pepper` (L-3).
 */
const KEY_VERSION_COLUMNS: readonly { table: string; purpose: KeyPurpose }[] = [
	{ table: "totp_credential", purpose: "totp-enc" },
	{ table: "recovery_code", purpose: "token-pepper" },
];

async function versionsMissingFromTheRing(
	keys: KeyProvider,
	purpose: KeyPurpose,
	stored: readonly number[],
): Promise<number[]> {
	const missing: number[] = [];
	for (const version of stored) {
		if ((await keys.byVersion(purpose, version)) === null) {
			missing.push(version);
		}
	}
	return missing;
}

/**
 * E-179's shape for the second factor: a key version that has left the ring is reported once, at
 * assembly, to the operator. On the sign-in path the same loss is indistinguishable from a wrong
 * code by design (E-428, E-1697), so without this the only signal is users who cannot get in.
 */
export async function assertStoredFactorKeyVersionsAreKnown(
	options: FactorKeyVersionCheckOptions,
): Promise<void> {
	const schema = assertSchemaName(options.schema ?? "velve");
	const missing: StoredFactorKeyVersions[] = [];

	for (const { table, purpose } of KEY_VERSION_COLUMNS) {
		const rows = await options.driver.query<{ key_version: number }>(
			`SELECT DISTINCT key_version FROM ${qualifiedTableName(schema, table)} ORDER BY key_version`,
			[],
		);
		const missingVersions = await versionsMissingFromTheRing(
			options.keys,
			purpose,
			rows.map((row) => Number(row.key_version)),
		);
		if (missingVersions.length > 0) {
			missing.push({ purpose, table, missingVersions });
		}
	}

	if (missing.length > 0) {
		throw new FactorKeyRingError(missing);
	}
}
