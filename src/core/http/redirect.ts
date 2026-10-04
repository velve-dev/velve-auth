import { VelveError } from "./error-map.js";
import type { RouteMetadata } from "./route.js";
import { isRecord } from "./validators.js";

export type RedirectPath = string & { readonly __brand: "RedirectPath" };

interface Redirect {
	readonly redirectToPath: RedirectPath;
}

const PATH_CHARACTERS = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/;

/** S-REDIR-1, S-REDIR-3 and S-REDIR-4: a path without a scheme, without a host and without a query, so no token can ride along. */
function isRedirectPath(value: string): boolean {
	return PATH_CHARACTERS.test(value) && !value.startsWith("//");
}

export function toRedirectPath(value: string): RedirectPath {
	if (!isRedirectPath(value)) {
		throw new VelveError("internal_error");
	}
	return value as RedirectPath;
}

export function redirectTo(path: RedirectPath): Redirect {
	return { redirectToPath: path };
}

const redirectingRoutes = new WeakSet<RouteMetadata>();

/** marks a built route as one whose output may become a 302, which only the OAuth callback is */
export function answerWithRedirect(route: RouteMetadata): void {
	redirectingRoutes.add(route);
}

//a route not marked here answers its output as JSON whatever fields it carries (S-REDIR-3)
export function readRedirectPath(route: RouteMetadata, output: unknown): RedirectPath | null {
	if (
		!redirectingRoutes.has(route) ||
		!isRecord(output) ||
		typeof output.redirectToPath !== "string"
	) {
		return null;
	}
	return toRedirectPath(output.redirectToPath);
}
