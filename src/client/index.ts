import type { AnyRoute } from "../core/http/route.js";
import { type ClientRoute, VELVE_CLIENT_ROUTES, type VelveRouteTable } from "./routes.js";
import type { ClientSurface } from "./surface.js";
import { createRouteCall, type RouteCall, type VelveClientOptions } from "./transport.js";

export { VelveError, type VelveErrorCode } from "../core/http/error-map.js";
export {
	unwrap,
	type VelveFailure,
	type VelveResult,
	VelveTransportError,
} from "./result.js";
export { type ClientRoute, VELVE_CLIENT_ROUTES, type VelveRouteTable } from "./routes.js";
export type { ClientMethodOf, ClientSurface } from "./surface.js";
export type { VelveClientOptions } from "./transport.js";

/**
 * 3.15 E derives the surface from `Auth["routes"]`, which is a preserved tuple only where the table
 * is declared `as const`; `VelveAuth` widens it, so a widened one is read as the library's own table
 * rather than as an unusable surface (E-676).
 */
type RouteTableOf<Auth extends { readonly routes: readonly AnyRoute[] }> =
	number extends Auth["routes"]["length"] ? VelveRouteTable : Auth["routes"];

function nestRouteCalls(routes: readonly ClientRoute[], call: RouteCall): Record<string, unknown> {
	const root: Record<string, unknown> = {};
	for (const route of routes) {
		const segments = route.name.split(".");
		const leaf = segments.pop() ?? "";
		let node = root;
		for (const segment of segments) {
			node[segment] ??= {};
			node = node[segment] as Record<string, unknown>;
		}
		node[leaf] = (input: unknown) => call(route, input);
	}
	return root;
}

/**
 * The table is iterated once, here, and every leaf reads its `method` and its `path` from the row it
 * was built from — 3.15 E rules out a proxy, a path assembled from property names and a method
 * guessed from the presence of a body.
 */
export function createVelveClient<
	Auth extends { readonly routes: readonly AnyRoute[] } = { readonly routes: VelveRouteTable },
>(options: VelveClientOptions): ClientSurface<RouteTableOf<Auth>> {
	const nested = nestRouteCalls(VELVE_CLIENT_ROUTES, createRouteCall(options));
	return nested as ClientSurface<RouteTableOf<Auth>>;
}
