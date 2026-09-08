import type { AnyRoute } from "./route.js";

export interface RouteMatch {
	readonly route: AnyRoute;
	readonly pathParameters: Readonly<Record<string, string>>;
}

/** ASCII only: Unicode case folding maps U+212A to "k", which would make /lin%E2%84%AA resolve to /link. */
function foldCase(segment: string): string {
	return segment.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
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
		if (foldCase(segments[index] ?? "") !== foldCase(baseSegment)) {
			return null;
		}
	}
	return segments.slice(baseSegments.length);
}

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
		} else if (foldCase(routeSegment) !== foldCase(requestSegment)) {
			return null;
		}
	}
	return captured;
}

function matchingPatternOf(route: AnyRoute): string {
	const segments = toSegments(route.path) ?? [];
	const pattern = segments
		.map((segment) => (segment.startsWith(":") ? ":" : foldCase(segment)))
		.join("/");
	return `${route.method} /${pattern}`;
}

/** 3.11: a conflict in the route table is a start error, and case folding makes two paths conflict that read as different. */
export function assertRouteTableIsUnambiguous(routes: readonly AnyRoute[]): void {
	const names = new Set<string>();
	const patterns = new Set<string>();

	for (const route of routes) {
		if (names.has(route.name)) {
			throw new Error(`Route name ${route.name} is declared more than once`);
		}
		names.add(route.name);

		if (route.caller === "server_only") {
			continue;
		}
		const pattern = matchingPatternOf(route);
		if (patterns.has(pattern)) {
			throw new Error(
				`Route ${route.name} answers ${pattern}, which another route already answers`,
			);
		}
		patterns.add(pattern);
	}
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
