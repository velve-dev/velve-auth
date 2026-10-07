import type { Driver } from "../db/driver.js";
import { qualifiedTableName } from "../db/identifier.js";
import type { KeyProvider } from "../keys/index.js";
import { keyTakesMac } from "../keys/mac.js";
import type { IntegrityKeyPurpose } from "../keys/purpose.js";
import { VelveStartupError } from "./startup.js";

//the seal and the three token tables are every place an integrity key version is stored (E-3191, E-3148)
function storedVersionsStatement(schema: string): string {
	const table = (name: string) => qualifiedTableName(schema, name);
	return `SELECT 'state-mac' AS purpose, key_version FROM ${table("security_state")}
	UNION SELECT 'token-mac', token_mac_key_version FROM ${table("session")}
	UNION SELECT 'token-mac', token_mac_key_version FROM ${table("one_time_token")}
	UNION SELECT 'token-mac', token_mac_key_version FROM ${table("pending_authentication")}
	ORDER BY 1, 2`;
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
