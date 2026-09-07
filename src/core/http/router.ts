import type { AnyRoute } from "./route.js";

export interface RouteMatch {
	readonly route: AnyRoute;
	readonly pathParameters: Readonly<Record<string, string>>;
}

function toSegments(path: string): readonly string[] | null {
	const segments: string[] = [];
	for (const rawSegment of path.split("/")) {
		if (rawSegment === "" || rawSegment === ".") {
			continue;
		}
		if (rawSegment === "..") {
			return null;
		}
		try {
			segments.push(decodeURIComponent(rawSegment));
		} catch {
			return null;
		}
	}
	return segments;
}

function withoutBase(
	segments: readonly string[],
	baseSegments: readonly string[],
): readonly string[] | null {
	if (segments.length < baseSegments.length) {
		return null;
	}
	for (const [index, baseSegment] of baseSegments.entries()) {
		if (segments[index] !== baseSegment) {
			return null;
		}
	}
	return segments.slice(baseSegments.length);
}

/** T-RATE-5 counts /TEST/ECHO and /test/echo on one bucket, so they must resolve to one route. */
function capturePathParameters(
	routeSegments: readonly string[],
	requestSegments: readonly string[],
): Readonly<Record<string, string>> | null {
	if (routeSegments.length !== requestSegments.length) {
		return null;
	}
	const captured: Record<string, string> = {};
	for (const [index, routeSegment] of routeSegments.entries()) {
		const requestSegment = requestSegments[index];
		if (requestSegment === undefined) {
			return null;
		}
		if (routeSegment.startsWith(":")) {
			captured[routeSegment.slice(1)] = requestSegment;
		} else if (routeSegment.toLowerCase() !== requestSegment.toLowerCase()) {
			return null;
		}
	}
	return captured;
}

export function matchRoute(
	routes: readonly AnyRoute[],
	method: string,
	pathname: string,
	basePath: string,
): RouteMatch | null {
	const requestSegments = toSegments(pathname);
	const baseSegments = toSegments(basePath);
	if (requestSegments === null || baseSegments === null) {
		return null;
	}
	const routableSegments = withoutBase(requestSegments, baseSegments);
	if (routableSegments === null) {
		return null;
	}

	for (const route of routes) {
		const routeSegments = toSegments(route.path);
		if (route.method !== method || route.caller === "server_only" || routeSegments === null) {
			continue;
		}
		const pathParameters = capturePathParameters(routeSegments, routableSegments);
		if (pathParameters !== null) {
			return { route, pathParameters };
		}
	}
	return null;
}
