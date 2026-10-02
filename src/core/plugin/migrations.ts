import type { RouteServices } from "../auth/routes.js";
import type { OwnedMigration } from "../db/migration.js";

//plugin migrations carry the plugin as owner and run after every core migration (E-635)
export function pluginMigrations(services: RouteServices): readonly OwnedMigration[] {
	return services.pluginRuntime.migrations;
}
