import type { RouteServices } from "../auth/routes.js";
import type { IdentityMode } from "../db/migrations/identity-mode.js";
import type { ServerSurface } from "../http/route.js";

/**
 * The rows of 3.15 D.3 that begin `/sign-in/oauth/` and `/identity/`, declared by the feature that
 * owns third-party sign-in. The table is composed here so that adding them is a change to this
 * file and never to the assembly — and the tuple return type is what carries the names into
 * `VelveAuth`, so `signIn.oauth.*` appears on the instance without `instance.ts` being edited.
 */
export function oauthRoutes(_services: RouteServices) {
	return [] as const;
}

/**
 * What this feature contributes to `VelveAuth<M>`. It is declared here rather than in the assembly
 * so that adding a namespace is a change to this file; `M` is a parameter because a namespace may
 * exist in one identity mode and not another (E-776).
 */
export type OAuthSurface<M extends IdentityMode> = M extends IdentityMode
	? ServerSurface<ReturnType<typeof oauthRoutes>>
	: never;
