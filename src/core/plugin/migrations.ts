import type { RouteServices } from "../auth/routes.js";
import type { OwnedMigration } from "../db/migration.js";

/**
 * 3.11 puts a plugin's migrations in the same versioned runner. They carry the plugin as their
 * owner, which is what keeps 3.15 G.1's first migration `1` out of the core's version space
 * (E-635); the runner applies them after every core migration, because a plugin's table references
 * `velve.user`.
 */
export function pluginMigrations(services: RouteServices): readonly OwnedMigration[] {
	return services.pluginRuntime.migrations;
}
