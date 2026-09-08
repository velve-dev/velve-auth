import type { ResolvedPendingAuthentication, Session } from "./caller.js";
import type { CookieWriter } from "./cookies.js";
import type { VelveErrorCode } from "./error-map.js";
import type { RateLimitRule } from "./rate-limit.js";
import { isRecord, type ObjectValidator } from "./validators.js";

export type HttpMethod = "GET" | "POST";
export type CallerRequirement = "anonymous" | "session" | "pending" | "server_only";
export type FreshnessRequirement = "not_required" | "required";
export type OriginRequirement = "checked" | "exempt";

/**
 * E-335: reading `__Host-velve_pending` and being authorised by it are two questions, and
 * `caller: "pending"` answered both. A route that reports or cancels the intermediate state needs
 * the value without the authority.
 */
export type PendingCookieAccess = "hidden" | "readable";

export interface RequestContext {
	readonly session: Session | null;
	readonly pending: ResolvedPendingAuthentication | null;
	readonly sessionToken: string | null;
	readonly pendingToken: string | null;
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
	/** Absent means hidden; `caller: "pending"` implies readable and may not say otherwise. */
	readonly pendingCookie?: PendingCookieAccess;
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
	readonly pendingCookie: PendingCookieAccess;
}

type RouteInvocation<Output> = (
	rawInput: unknown,
	resolveContext: () => Promise<RequestContext>,
) => Promise<Output>;

declare const routeOutput: unique symbol;

/** 3.11: the output type is carried by a phantom property, so the route object holds no member that runs it and none that Reflect.ownKeys can find. */
export interface RunnableRoute<Output> extends RouteMetadata {
	readonly [routeOutput]?: Output;
}

export type AnyRoute = RunnableRoute<unknown>;

const invocations = new WeakMap<RouteMetadata, RouteInvocation<unknown>>();

export function invocationOf<Output>(route: RunnableRoute<Output>): RouteInvocation<Output> {
	const invocation = invocations.get(route);
	if (invocation === undefined) {
		throw new Error(`Route ${route.name} was not built by defineRoute`);
	}
	// defineRoute is the only writer, and it stores the invocation of exactly this route.
	return invocation as RouteInvocation<Output>;
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

const SERVER_CALL_FIELDS = new Set<string>([
	"origin",
	"sessionToken",
	"pendingToken",
	"ipAddress",
	"userAgent",
]);

/** The direct server call carries these five fields beside the input, so an input field of the same name would be stripped there and kept over HTTP. */
function assertInputLeavesTheCallEnvelopeAlone(name: string, fields: readonly string[]): void {
	for (const field of fields) {
		if (SERVER_CALL_FIELDS.has(field)) {
			throw new Error(
				`Route ${name} declares an input field ${field}, which a server call reserves`,
			);
		}
	}
}

function pathParameterNames(path: string): readonly string[] {
	return path
		.split("/")
		.filter((segment) => segment.startsWith(":"))
		.map((segment) => segment.slice(1));
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

function pendingCookieAccessOf(
	name: string,
	caller: CallerRequirement,
	declared: PendingCookieAccess | undefined,
): PendingCookieAccess {
	if (caller !== "pending") {
		return declared ?? "hidden";
	}
	if (declared === "hidden") {
		throw new Error(`Route ${name} is authorised by the pending state and cannot hide its cookie`);
	}
	return "readable";
}

/** S-CACHE-4: the one predicate that says whether a route may see `__Host-velve_pending`. */
export function readsPendingCookie(route: RouteMetadata): boolean {
	return route.pendingCookie === "readable";
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
	assertInputLeavesTheCallEnvelopeAlone(declaration.name, [
		...declaration.input.fields,
		...pathParameterNames(declaration.path),
	]);

	const route: Route<Name, Path, Input, Output, Code> = {
		name: declaration.name,
		method: declaration.method,
		path: declaration.path,
		input: declaration.input,
		errors: declaration.errors,
		caller: declaration.caller,
		freshness: declaration.freshness,
		originCheck: declaration.originCheck,
		rateLimit: declaration.rateLimit,
		pendingCookie: pendingCookieAccessOf(
			declaration.name,
			declaration.caller,
			declaration.pendingCookie,
		),
	};

	// 3.15 D.2 fixes the order: the input is parsed before the caller is resolved.
	invocations.set(route, async (rawInput, resolveContext) => {
		const input = declaration.input.parse(
			declaration.method === "GET"
				? declaredFieldsOnly(rawInput, declaration.input.fields)
				: rawInput,
		);
		return declaration.handler(input, await resolveContext());
	});

	return route;
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
