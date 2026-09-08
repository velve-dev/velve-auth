import type { RouteServices } from "../auth/routes.js";
import type { AnyRoute } from "../http/route.js";

/**
 * The rows of 3.15 D.3 that begin `/sign-in/oauth/` and `/identity/`, declared by the feature that
 * owns third-party sign-in. The table is composed here so that adding them is a change to this
 * file and never to the assembly.
 */
export function oauthRoutes(_services: RouteServices): readonly AnyRoute[] {
	return [];
}
