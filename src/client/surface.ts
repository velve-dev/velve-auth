import type { VelveErrorCode } from "../core/http/error-map.js";
import type { AnyRoute, Nest, Route, UnionToIntersection } from "../core/http/route.js";
import type { VelveResult } from "./result.js";

/**
 * The mirror of `ServerMethodOf` from the same declaration: no call envelope, because the browser
 * sends the cookies, and the result object of 3.15 E instead of a throw. `[Code]` keeps the
 * conditional from distributing, so a route's whole error list stays one union.
 */
export type ClientMethodOf<Declared> =
	Declared extends Route<string, string, infer Input, infer Output, infer Code>
		? [Code] extends [VelveErrorCode]
			? (input: Input) => Promise<VelveResult<Output, Code>>
			: never
		: never;

export type ClientSurface<Routes extends readonly AnyRoute[]> = UnionToIntersection<
	{ [Index in keyof Routes]: Nest<Routes[Index]["name"], ClientMethodOf<Routes[Index]>> }[number]
>;
