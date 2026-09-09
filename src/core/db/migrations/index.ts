import type { Migration } from "../migration.js";
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
 * core owns is asking about the schema and not about one configuration of it.
 */
export function coreTableNames(): readonly string[] {
	const named = EVERY_IDENTITY_MODE.flatMap((mode) =>
		coreMigrations(mode).flatMap((migration) =>
			[...migration.sql.matchAll(CREATES_A_TABLE)].map((match) => String(match[1]).toLowerCase()),
		),
	);
	return [...new Set(named)];
}
