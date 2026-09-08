import type { RouteServices } from "../auth/routes.js";
import type { AnyRoute } from "../http/route.js";

/**
 * The rows of 3.15 D.3 that carry an e-mailed one-time artefact — sign-up, magic link, password
 * reset, address verification and address change. Composed here so that adding them is a change to
 * this file and never to the assembly.
 */
export function emailFlowRoutes(_services: RouteServices): readonly AnyRoute[] {
	return [];
}
