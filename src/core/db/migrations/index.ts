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
