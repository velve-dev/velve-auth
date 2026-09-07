import type { Migration } from "../migration.js";
import { type IdentityMode, identityModeMigration } from "./identity-mode.js";
import { initialSchema } from "./initial-schema.js";

export function coreMigrations(identityMode: IdentityMode): readonly Migration[] {
	return [initialSchema, identityModeMigration(identityMode)];
}
