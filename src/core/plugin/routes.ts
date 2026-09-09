import type { RouteServices } from "../auth/routes.js";
import type { IdentityMode } from "../db/migrations/identity-mode.js";
import type { AnyRoute } from "../http/route.js";

/**
 * 3.11: a plugin contributes routes under `/x/<plugin-id>/`, and they enter the table the same way
 * the core's do. The registry has already built and ordered them; this seam is where they join the
 * table, so adding them is a change to this file and never to the assembly.
 */
export function pluginRoutes(services: RouteServices): readonly AnyRoute[] {
	return services.pluginRuntime.routes;
}

/**
 * A plugin's routes are configuration and are not known when the type is written, so this feature
 * contributes nothing to `VelveAuth<M>` — `auth.<pluginId>.<method>` exists on the object and not
 * in the type. The alias is declared for symmetry with the other two seams (E-776).
 */
export type PluginSurface<M extends IdentityMode> = M extends IdentityMode
	? Record<never, never>
	: never;
