import type { HttpEnvironment } from "../http/environment.js";
import type { AnyRoute } from "../http/route.js";
import { createServerMethodOfAnyRoute } from "../http/server-method.js";
import { VelveStartupError } from "./startup.js";

function isNamespace(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * A segment every object already carries. `__proto__` is the one that matters — reading it walks
 * to `Object.prototype` and writing it moves the prototype — and the other two are refused beside
 * it because a namespace shadowing them reads as something it is not (E-663).
 */
const SEGMENTS_NO_ROUTE_NAME_MAY_USE: readonly string[] = ["__proto__", "constructor", "prototype"];

function assertSegmentIsWritable(segment: string): void {
	if (SEGMENTS_NO_ROUTE_NAME_MAY_USE.includes(segment)) {
		throw new VelveStartupError("route_name_segment_reserved");
	}
}

/** Own properties only, and defined rather than assigned, so no segment can reach a prototype. */
function namespaceUnder(node: Record<string, unknown>, segment: string): Record<string, unknown> {
	const existing = Object.hasOwn(node, segment) ? node[segment] : undefined;
	if (existing !== undefined) {
		if (!isNamespace(existing)) {
			throw new VelveStartupError("route_namespace_conflict");
		}
		return existing;
	}
	const created: Record<string, unknown> = {};
	Object.defineProperty(node, segment, {
		value: created,
		writable: true,
		enumerable: true,
		configurable: true,
	});
	return created;
}

/**
 * 3.15 D.2: the dotted `name` is the object path of the server method, so a feature that adds a
 * row named `signIn.oauth.start` in its own file gets `auth.signIn.oauth.start` without any other
 * file being edited — which is what makes one `signIn` namespace safe for two features (E-743).
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
			assertSegmentIsWritable(segment);
			node = namespaceUnder(node, segment);
		}
		assertSegmentIsWritable(leaf);
		if (Object.hasOwn(node, leaf)) {
			throw new VelveStartupError("route_namespace_conflict");
		}
		Object.defineProperty(node, leaf, {
			value: createServerMethodOfAnyRoute(route, environment),
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}
	return root;
}

/**
 * E-1192: the assembly spreads the derived namespaces and then states a handful of its own after
 * them, so a name written by hand replaces a whole namespace a route source had contributed —
 * silently, and however many methods were under it. A collision between the two is refused here
 * instead of being resolved by the order of an object literal.
 */
export function assertNoStatedNameShadowsADerivedOne(
	derived: Record<string, unknown>,
	stated: Record<string, unknown>,
): void {
	for (const name of Object.keys(stated)) {
		if (Object.hasOwn(derived, name)) {
			throw new VelveStartupError("route_namespace_conflict");
		}
	}
}
