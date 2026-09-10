import { type Migration, PLUGIN_LEDGER_TABLE } from "../migration.js";
import { type IdentityMode, identityModeMigration } from "./identity-mode.js";
import { initialSchema } from "./initial-schema.js";

export function coreMigrations(identityMode: IdentityMode): readonly Migration[] {
	return [initialSchema, identityModeMigration(identityMode)];
}

const CREATES_A_TABLE =
	/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[A-Za-z_][A-Za-z0-9_$]*\.([A-Za-z_][A-Za-z0-9_$]*)/gi;

const EVERY_IDENTITY_MODE: readonly IdentityMode[] = ["email", "username", "username_email"];

/**
 * The names of the core tables, read out of the SQL that creates them, so no second list of them
 * exists to fall behind the first (E-761). Every mode is read, because a caller asking what the
 * core owns is asking about the schema and not about one configuration of it. The plugins' ledger
 * is created by the runner rather than by a migration, so it is named from its one definition
 * rather than parsed out of SQL that does not exist (E-638).
 */
export function coreTableNames(): readonly string[] {
	const named = EVERY_IDENTITY_MODE.flatMap((mode) =>
		coreMigrations(mode).flatMap((migration) =>
			[...migration.sql.matchAll(CREATES_A_TABLE)].map((match) => String(match[1]).toLowerCase()),
		),
	);
	return [...new Set([...named, PLUGIN_LEDGER_TABLE])];
}

let coreTables: ReadonlySet<string> | undefined;

/** E-775: an empty set would make the rule both plugin boundaries rest on permit everything, silently. */
export function coreTableNameSet(): ReadonlySet<string> {
	coreTables ??= new Set(coreTableNames());
	if (coreTables.size === 0) {
		throw new TypeError("no core table name could be read out of the migrations that create them");
	}
	return coreTables;
}

/**
 * Ownership as **both** plugin boundaries decide it — `ownTables.query` at runtime and the
 * migration runner at startup — so neither can widen without the other. The prefix alone does not
 * decide it, because a core table name carries `_` as well: `one_time_token` begins with the prefix
 * of a plugin called `one`, and that plugin could mint a password reset token against any account
 * (E-907).
 */
export function namesTableOfPlugin(tableName: string, pluginId: string): boolean {
	return tableName.startsWith(`${pluginId}_`) && !coreTableNameSet().has(tableName.toLowerCase());
}
