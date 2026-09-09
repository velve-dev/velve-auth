import type { RouteServices } from "../auth/routes.js";
import type { Migration } from "../db/migration.js";

/**
 * 3.11 puts a plugin's migrations in the same versioned runner. They do not run yet — the runner
 * keys its ledger on `version` alone and 3.15 G.1's example numbers its first migration `1`, which
 * collides with the core's, and namespacing that is a decision this feature did not take (E-748).
 * The seam exists so that taking it is a change to this file and never to the assembly (E-776).
 */
export function pluginMigrations(_services: RouteServices): readonly Migration[] {
	return [];
}
