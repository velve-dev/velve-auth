import type { RouteServices } from "../auth/routes.js";
import type { IdentityMode } from "../db/migrations/identity-mode.js";
import type { AnyRoute } from "../http/route.js";

//adding plugin routes must change this file and never the assembly
export function pluginRoutes(services: RouteServices): readonly AnyRoute[] {
	return services.pluginRuntime.routes;
}

/** adds nothing to `VelveAuth<M>`, as a plugin's routes exist only on the object */
export type PluginSurface<M extends IdentityMode> = M extends IdentityMode
	? Record<never, never>
	: never;
