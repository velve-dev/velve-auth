import { type Migration, PLUGIN_LEDGER_TABLE } from "../migration.js";
import { type IdentityMode, identityModeMigration } from "./identity-mode.js";
import { initialSchema } from "./initial-schema.js";
import { securityStateSchema } from "./security-state.js";
import { tokenMacSchema } from "./token-mac.js";

export function coreMigrations(identityMode: IdentityMode): readonly Migration[] {
	return [initialSchema, identityModeMigration(identityMode), securityStateSchema, tokenMacSchema];
}

const CREATES_A_TABLE =
	/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[A-Za-z_][A-Za-z0-9_$]*\.([A-Za-z_][A-Za-z0-9_$]*)/gi;

const EVERY_IDENTITY_MODE: readonly IdentityMode[] = ["email", "username", "username_email"];

//core table names come from the creating SQL so no second list can fall behind (E-761)
export function coreTableNames(): readonly string[] {
	const named = EVERY_IDENTITY_MODE.flatMap((mode) =>
		coreMigrations(mode).flatMap((migration) =>
			[...migration.sql.matchAll(CREATES_A_TABLE)].map((match) => String(match[1]).toLowerCase()),
		),
	);
	return [...new Set([...named, PLUGIN_LEDGER_TABLE])];
}

let coreTables: ReadonlySet<string> | undefined;

//an empty set would silently let both plugin boundaries permit everything (E-775)
export function coreTableNameSet(): ReadonlySet<string> {
	coreTables ??= new Set(coreTableNames());
	if (coreTables.size === 0) {
		throw new TypeError("no core table name could be read out of the migrations that create them");
	}
	return coreTables;
}

//a prefix match alone would hand a core table like one_time_token to a plugin (E-907)
export function namesTableOfPlugin(tableName: string, pluginId: string): boolean {
	return tableName.startsWith(`${pluginId}_`) && !coreTableNameSet().has(tableName.toLowerCase());
}
