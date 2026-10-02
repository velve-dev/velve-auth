import type { VelveErrorCode } from "../core/http/error-map.js";
import type { AnyRoute, Nest, Route, UnionToIntersection } from "../core/http/route.js";
import type { VelveResult } from "./result.js";

/** a server method as the browser calls it, with no envelope and a result instead of a throw */
export type ClientMethodOf<Declared> =
	Declared extends Route<string, string, infer Input, infer Output, infer Code>
		? [Code] extends [VelveErrorCode]
			? (input: Input) => Promise<VelveResult<Output, Code>>
			: never
		: never;

export type ClientSurface<Routes extends readonly AnyRoute[]> = UnionToIntersection<
	{ [Index in keyof Routes]: Nest<Routes[Index]["name"], ClientMethodOf<Routes[Index]>> }[number]
>;
