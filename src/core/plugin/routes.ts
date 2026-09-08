import type { RouteServices } from "../auth/routes.js";
import type { AnyRoute } from "../http/route.js";

/**
 * 3.11: a plugin contributes routes under `/x/<plugin-id>/`, and they enter the table the same way
 * the core's do. Composed here so that adding them is a change to this file and never to the
 * assembly.
 */
export function pluginRoutes(_services: RouteServices): readonly AnyRoute[] {
	return [];
}
