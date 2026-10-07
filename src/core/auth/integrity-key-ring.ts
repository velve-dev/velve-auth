import type { Driver } from "../db/driver.js";
import { qualifiedTableName } from "../db/identifier.js";
import type { KeyProvider } from "../keys/index.js";
import { keyTakesMac } from "../keys/mac.js";
import type { IntegrityKeyPurpose } from "../keys/purpose.js";
import { VelveStartupError } from "./startup.js";

const TOKEN_TABLES = ["session", "one_time_token", "pending_authentication"] as const;

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

//a version no row names is never read so only the stored ones are probed (E-3191)
export async function assertStoredIntegrityKeysTakeMac(options: {
	readonly driver: Driver;
	readonly keys: KeyProvider;
	readonly schema: string;
}): Promise<void> {
	const rows = await options.driver.query<{
		purpose: IntegrityKeyPurpose;
		key_version: number;
	}>(storedVersionsStatement(options.schema), []);
	for (const row of rows) {
		const key = await options.keys.byVersion(row.purpose, row.key_version);
		//a version that left the ring is a broken state of those accounts and not a start error (E-3191)
		if (key !== null && !(await keyTakesMac(key))) {
			throw new VelveStartupError("keys_unusable");
		}
	}
}
