import type { FrozenContext } from "../plugin/config.js";
import type { ResolvedPendingAuthentication, Session } from "./caller.js";
import type { CookieWriter } from "./cookies.js";
import type { AnyErrorCode } from "./error-map.js";
import type { RateLimitRule } from "./rate-limit.js";
import { isRecord, type ObjectValidator } from "./validators.js";

export type HttpMethod = "GET" | "POST";
export type CallerRequirement = "anonymous" | "session" | "pending" | "server_only";
export type FreshnessRequirement = "not_required" | "required";
export type OriginRequirement = "checked" | "exempt";

/** whether a route may read the pending cookie without being authorised by it */
export type PendingCookieAccess = "hidden" | "readable";

/** whether a route may read the OAuth state cookie, which authorises nothing on its own */
export type OAuthStateCookieAccess = "hidden" | "readable";

/** how a POST body arrives, where `form` serves only a provider's `form_post` callback */
export type RequestBodyFormat = "json" | "form";

export interface RequestContext {
	readonly session: Session | null;
	readonly pending: ResolvedPendingAuthentication | null;
	readonly sessionToken: string | null;
	readonly pendingToken: string | null;
	readonly oauthStateToken: string | null;
	readonly ipAddress: string | null;
	readonly userAgent: string | null;
	readonly cookies: CookieWriter;
	/** the frozen plugin context, which for a core route carries no tables of its own */
	readonly plugin: FrozenContext;
	enforceAccountRateLimit(normalisedIdentifier: string): Promise<void>;
}

export interface RouteDeclaration<
	Name extends string,
	Path extends string,
	Input,
	Output,
	Code extends AnyErrorCode,
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
	/** absent means hidden, and a pending caller implies readable and may not say otherwise */
	readonly pendingCookie?: PendingCookieAccess;
	/** absent means hidden, and no caller requirement implies it, so a route reading it says so */
	readonly oauthStateCookie?: OAuthStateCookieAccess;
	/** absent means JSON, which every route the application itself calls sends */
	readonly requestBody?: RequestBodyFormat;
	readonly handler: (input: Input, context: RequestContext) => Promise<Output>;
}

export interface RouteMetadata {
	readonly name: string;
	readonly method: HttpMethod;
	readonly path: string;
	readonly errors: readonly AnyErrorCode[];
	readonly caller: CallerRequirement;
	readonly freshness: FreshnessRequirement;
	readonly originCheck: OriginRequirement;
	readonly rateLimit: RateLimitRule;
	readonly pendingCookie: PendingCookieAccess;
	readonly oauthStateCookie: OAuthStateCookieAccess;
	readonly requestBody: RequestBodyFormat;
}

type RouteInvocation<Output> = (
	rawInput: unknown,
	resolveContext: () => Promise<RequestContext>,
) => Promise<Output>;

declare const routeOutput: unique symbol;

/** a route typed by a phantom property, with no member that runs it even under `Reflect.ownKeys` */
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
	//the cast is sound only while defineRoute stays the one writer of this map
	return invocation as RouteInvocation<Output>;
}

/** a built route, which carries no handler, so no caller holding it can reach past the checks */
export interface Route<
	Name extends string,
	Path extends string,
	Input,
	Output,
	Code extends AnyErrorCode,
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

//query strings and provider forms carry parameters no declaration can enumerate
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
	"oauthStateToken",
	"ipAddress",
	"userAgent",
]);

//an input field named like the call envelope would be stripped directly but kept over HTTP
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

//the one predicate that decides whether a route may see the pending cookie (S-CACHE-4)
export function readsPendingCookie(route: RouteMetadata): boolean {
	return route.pendingCookie === "readable";
}

//the one predicate that decides whether a route may see the state cookie (S-CSRF-5)
export function readsOAuthStateCookie(route: RouteMetadata): boolean {
	return route.oauthStateCookie === "readable";
}

const readingRoutes = new WeakSet<RouteMetadata>();

//a core get route is reading and a plugin get route is not known to be (S-CSRF-4)
export function classifyCoreReadingRoutes(coreRoutes: readonly RouteMetadata[]): void {
	for (const route of coreRoutes) {
		if (route.method === "GET" && route.originCheck === "checked") {
			readingRoutes.add(route);
		}
	}
}

//the one predicate that decides whether a route is reading, held against the route object (E-740)
export function isReadingRoute(route: RouteMetadata): boolean {
	return readingRoutes.has(route);
}

export function defineRoute<
	Name extends string,
	Path extends string,
	Input,
	Output,
	Code extends AnyErrorCode,
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
		oauthStateCookie: declaration.oauthStateCookie ?? "hidden",
		requestBody: declaration.requestBody ?? "json",
	};

	//the input must be parsed before the caller is resolved
	invocations.set(route, async (rawInput, resolveContext) => {
		const input = declaration.input.parse(
			declaration.method === "GET" || route.requestBody === "form"
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
	readonly oauthStateToken?: string;
	readonly ipAddress?: string | null;
	readonly userAgent?: string | null;
}

export type ServerMethodOf<R> =
	R extends Route<string, string, infer Input, infer Output, AnyErrorCode>
		? (input: Input & ServerCallFields) => Promise<Output>
		: never;

export type Nest<Name extends string, Method> = Name extends `${infer Head}.${infer Rest}`
	? { [Key in Head]: Nest<Rest, Method> }
	: { [Key in Name]: Method };

export type UnionToIntersection<Union> = (
	Union extends unknown
		? (argument: Union) => void
		: never
) extends (argument: infer Intersection) => void
	? Intersection
	: never;

export type ServerSurface<Routes extends readonly AnyRoute[]> = UnionToIntersection<
	{ [Index in keyof Routes]: Nest<Routes[Index]["name"], ServerMethodOf<Routes[Index]>> }[number]
>;
