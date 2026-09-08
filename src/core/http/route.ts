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

export interface RouteMetadata {
	readonly name: string;
	readonly method: HttpMethod;
	readonly path: string;
	readonly errors: readonly VelveErrorCode[];
	readonly caller: CallerRequirement;
	readonly freshness: FreshnessRequirement;
	readonly originCheck: OriginRequirement;
	readonly rateLimit: RateLimitRule;
}

export type RouteInvocation<Output> = (
	rawInput: unknown,
	resolveContext: () => Promise<RequestContext>,
) => Promise<Output>;

/** 3.11: the invocation is reachable only through runRoute, so a route object alone cannot skip the checks in front of it. */
const routeInvocation: unique symbol = Symbol("velve.route.invocation");

export interface RunnableRoute<Output> extends RouteMetadata {
	readonly [routeInvocation]: RouteInvocation<Output>;
}

export type AnyRoute = RunnableRoute<unknown>;

export function invocationOf<Output>(route: RunnableRoute<Output>): RouteInvocation<Output> {
	return route[routeInvocation];
}

/** The declaration carries the handler; the route built from it does not, so no caller holding a route can reach past the checks. */
export interface Route<
	Name extends string,
	Path extends string,
	Input,
	Output,
	Code extends VelveErrorCode,
> extends RouteMetadata,
		RunnableRoute<Output> {
	readonly name: Name;
	readonly path: Path;
	readonly errors: readonly Code[];
	readonly input: ObjectValidator<Input>;
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
		name: declaration.name,
		method: declaration.method,
		path: declaration.path,
		input: declaration.input,
		errors: declaration.errors,
		caller: declaration.caller,
		freshness: declaration.freshness,
		originCheck: declaration.originCheck,
		rateLimit: declaration.rateLimit,
		// 3.15 D.2 fixes the order: the input is parsed before the caller is resolved.
		[routeInvocation]: async (rawInput, resolveContext) => {
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
	R extends Route<string, string, infer Input, infer Output, VelveErrorCode>
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
