import type { RouteServices } from "../auth/routes.js";
import type { IdentityMode } from "../db/migrations/identity-mode.js";
import type { ServerSurface } from "../http/route.js";

/**
 * The rows of 3.15 D.3 that carry an e-mailed one-time artefact — sign-up, magic link, password
 * reset, address verification and address change. Composed here so that adding them is a change to
 * this file and never to the assembly; the tuple return type carries `signIn.magicLink.*` onto the
 * instance without any other file naming it.
 */
export function emailFlowRoutes(_services: RouteServices) {
	return [] as const;
}

/**
 * What this feature contributes to `VelveAuth<M>`. `M` is a parameter because the `/email/*` routes
 * exist in `email` and `username_email` and not in `username`, so the namespaces this feature adds
 * are conditional on the mode and the condition is written here (E-776).
 */
export type EmailFlowSurface<M extends IdentityMode> = M extends IdentityMode
	? ServerSurface<ReturnType<typeof emailFlowRoutes>>
	: never;
