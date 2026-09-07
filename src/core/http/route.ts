import type { PendingAuthentication, Session } from "./caller.js";
import type { CookieWriter } from "./cookies.js";
import type { VelveErrorCode } from "./error-map.js";
import type { RateLimitRule } from "./rate-limit.js";
import { isRecord, type ObjectValidator } from "./validators.js";

export type HttpMethod = "GET" | "POST";
export type CallerRequirement = "anonymous" | "session" | "pending" | "server_only";
export type FreshnessRequirement = "not_required" | "required";
export type OriginRequirement = "checked" | "exempt";

export interface RequestContext {
	readonly session: Session | null;
	readonly pending: PendingAuthentication | null;
	readonly sessionToken: string | null;
	readonly ipAddress: string | null;
	readonly userAgent: string | null;
	readonly cookies: CookieWriter;
	enforceAccountRateLimit(normalisedIdentifier: string): Promise<void>;
}

export interface RouteDeclaration<
	Name extends string,
	Path extends string,
	Input,
	Output,
	Code extends VelveErrorCode,
> {
	readonly name: Name;
	readonly method: HttpMethod;
	readonly path: Path;
	readonly input: ObjectValidator<Input>;
	readonly errors: readonly Code[];
	readonly caller: CallerRequirement;
	readonly freshness: FreshnessRequirement;
	readonly originCheck: OriginRequirement;
	readonly rateLimit: RateLimitRule;
	readonly handler: (input: Input, context: RequestContext) => Promise<Output>;
}

export interface RouteRuntime<Output> {
	readonly name: string;
	readonly caller: CallerRequirement;
	readonly freshness: FreshnessRequirement;
	readonly originCheck: OriginRequirement;
	readonly rateLimit: RateLimitRule;
	readonly invoke: (
		rawInput: unknown,
		resolveContext: () => Promise<RequestContext>,
	) => Promise<Output>;
}

export interface Route<
	Name extends string,
	Path extends string,
	Input,
	Output,
	Code extends VelveErrorCode,
> extends RouteDeclaration<Name, Path, Input, Output, Code>,
		RouteRuntime<Output> {
	readonly name: Name;
}

export interface AnyRoute extends RouteRuntime<unknown> {
	readonly method: HttpMethod;
	readonly path: string;
	readonly errors: readonly VelveErrorCode[];
}

function assertPathIsRoutable(path: string): void {
	if (!path.startsWith("/") || path.includes("//") || path.endsWith("/")) {
		throw new Error(
			`Route path ${path} must be slash-separated, absolute and without empty segments`,
		);
	}
}

/** A GET route reads its input from the query string, where a provider appends parameters no declaration can enumerate. */
function declaredFieldsOnly(rawInput: unknown, fields: readonly string[]): unknown {
	if (!isRecord(rawInput)) {
		return rawInput;
	}
	const declared: Record<string, unknown> = {};
	for (const field of fields) {
		if (Object.hasOwn(rawInput, field)) {
			declared[field] = rawInput[field];
		}
	}
	return declared;
}

function assertFreshnessHasASession(
	name: string,
	caller: CallerRequirement,
	freshness: FreshnessRequirement,
): void {
	if (freshness === "required" && caller !== "session") {
		throw new Error(`Route ${name} requires freshness but does not require a session`);
	}
}

export function defineRoute<
	Name extends string,
	Path extends string,
	Input,
	Output,
	Code extends VelveErrorCode,
>(
	declaration: RouteDeclaration<Name, Path, Input, Output, Code>,
): Route<Name, Path, Input, Output, Code> {
	assertPathIsRoutable(declaration.path);
	assertFreshnessHasASession(declaration.name, declaration.caller, declaration.freshness);

	return {
		...declaration,
		// 3.15 D.2 fixes the order: the input is parsed before the caller is resolved.
		invoke: async (rawInput, resolveContext) => {
			const input = declaration.input.parse(
				declaration.method === "GET"
					? declaredFieldsOnly(rawInput, declaration.input.fields)
					: rawInput,
			);
			return declaration.handler(input, await resolveContext());
		},
	};
}

export interface ServerCallFields {
	readonly origin: string | null;
	readonly sessionToken?: string;
	readonly pendingToken?: string;
	readonly ipAddress?: string | null;
	readonly userAgent?: string | null;
}

export type ServerMethodOf<R> =
	R extends RouteDeclaration<string, string, infer Input, infer Output, VelveErrorCode>
		? (input: Input & ServerCallFields) => Promise<Output>
		: never;

export type Nest<Name extends string, Method> = Name extends `${infer Head}.${infer Rest}`
	? { [Key in Head]: Nest<Rest, Method> }
	: { [Key in Name]: Method };

type UnionToIntersection<Union> = (
	Union extends unknown
		? (argument: Union) => void
		: never
) extends (argument: infer Intersection) => void
	? Intersection
	: never;

export type ServerSurface<Routes extends readonly AnyRoute[]> = UnionToIntersection<
	{ [Index in keyof Routes]: Nest<Routes[Index]["name"], ServerMethodOf<Routes[Index]>> }[number]
>;
