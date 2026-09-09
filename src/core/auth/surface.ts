import type { HttpEnvironment } from "../http/environment.js";
import type { AnyRoute } from "../http/route.js";
import { createServerMethodOfAnyRoute } from "../http/server-method.js";
import { VelveStartupError } from "./startup.js";

function isNamespace(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * 3.15 D.2: the dotted `name` is the object path of the server method, so a feature that adds a
 * row named `signIn.oauth.start` in its own file gets `auth.signIn.oauth.start` without any other
 * file being edited. That is what makes one `signIn` namespace safe for two features to fill.
 */
export function nestServerMethods(
	routes: readonly AnyRoute[],
	environment: HttpEnvironment,
): Record<string, unknown> {
	const root: Record<string, unknown> = {};
	for (const route of routes) {
		const segments = route.name.split(".");
		const leaf = segments.pop() ?? "";
		let node = root;
		for (const segment of segments) {
			const existing = node[segment];
			if (existing === undefined) {
				node[segment] = {};
			} else if (!isNamespace(existing)) {
				throw new VelveStartupError("route_namespace_conflict");
			}
			node = node[segment] as Record<string, unknown>;
		}
		if (leaf in node) {
			throw new VelveStartupError("route_namespace_conflict");
		}
		node[leaf] = createServerMethodOfAnyRoute(route, environment);
	}
	return root;
}
