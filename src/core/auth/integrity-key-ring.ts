import type { Driver } from "../db/driver.js";
import { qualifiedTableName } from "../db/identifier.js";
import type { KeyProvider } from "../keys/index.js";
import { keyTakesMac } from "../keys/mac.js";
import { VelveStartupError } from "./startup.js";

//a version no row names is never read so only the stored ones are probed (E-3191)
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
	for (const row of rows) {
		const key = await options.keys.byVersion("state-mac", row.key_version);
		//a version that left the ring is a broken state of those accounts and not a start error (E-3191)
		if (key !== null && !(await keyTakesMac(key))) {
			throw new VelveStartupError("keys_unusable");
		}
	}
}
