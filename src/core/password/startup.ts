import type { Driver } from "../db/driver.js";
import { qualifiedTableName } from "../db/identifier.js";
import type { KeyProvider } from "../keys/index.js";
import {
	PASSWORD_CREDENTIAL_SCHEMA,
	PASSWORD_CREDENTIAL_TABLE,
	PASSWORD_ENC_PURPOSE,
} from "./credential.js";

export class PasswordKeyRingError extends Error {
	readonly code = "stored_key_version_unknown";
	readonly missingVersions: readonly number[];

	constructor(missingVersions: readonly number[]) {
		super(
			`stored password credentials name ${PASSWORD_ENC_PURPOSE} key version ` +
				`${missingVersions.join(", ")}, which the key ring does not hold`,
		);
		this.name = "PasswordKeyRingError";
		this.missingVersions = missingVersions;
	}
}

export interface StoredKeyVersionCheckOptions {
	readonly driver: Driver;
	readonly keys: KeyProvider;
	readonly schema?: string;
}

/**
 * L-2 makes the key ring a precondition for every stored password, so a version that has left the
 * ring locks out everyone whose row was written under it. Reported here — once, at assembly, to
 * the operator — rather than per sign-in to a user, where it would also partition accounts into
 * those written before a rotation and those written after (E-179).
 */
export async function assertStoredKeyVersionsAreKnown(
	options: StoredKeyVersionCheckOptions,
): Promise<void> {
	const table = qualifiedTableName(
		options.schema ?? PASSWORD_CREDENTIAL_SCHEMA,
		PASSWORD_CREDENTIAL_TABLE,
	);

	const rows = await options.driver.query<{ key_version: number }>(
		`SELECT DISTINCT key_version FROM ${table} ORDER BY key_version`,
		[],
	);

	const missing: number[] = [];
	for (const row of rows) {
		if ((await options.keys.byVersion(PASSWORD_ENC_PURPOSE, row.key_version)) === null) {
			missing.push(row.key_version);
		}
	}

	if (missing.length > 0) {
		throw new PasswordKeyRingError(missing);
	}
}
