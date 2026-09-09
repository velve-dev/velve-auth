import type { RouteServices } from "../auth/routes.js";

/**
 * The rows of 3.15 D.3 that carry an e-mailed one-time artefact — sign-up, magic link, password
 * reset, address verification and address change. Composed here so that adding them is a change to
 * this file and never to the assembly; the tuple return type carries `signIn.magicLink.*` onto the
 * instance without any other file naming it.
 */
export function emailFlowRoutes(_services: RouteServices) {
	return [] as const;
}
