import type { RouteServices } from "../auth/routes.js";
import type { AnyRoute } from "../http/route.js";

/**
 * 3.11: a plugin contributes routes under `/x/<plugin-id>/`, and they enter the table the same way
 * the core's do. The registry has already built and ordered them; this seam is where they join the
 * table, so adding them is a change to this file and never to the assembly.
 */
export function pluginRoutes(services: RouteServices): readonly AnyRoute[] {
	return services.pluginRuntime.routes;
}
