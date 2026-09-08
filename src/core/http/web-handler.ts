import {
	assertCookieNamesAreEnumerated,
	type CookieInstruction,
	createCookieCollector,
	readCookies,
} from "./cookies.js";
import { cookiePolicyOf, type HttpEnvironment, type WebHandlerTarget } from "./environment.js";
import { VelveError } from "./error-map.js";
import { type RouteCall, type RouteOutcome, runRoute, toLoggedFailure } from "./pipeline.js";
import { readRedirectPath } from "./redirect.js";
import { bodilessResponse, errorResponse, jsonResponse, redirectResponse } from "./response.js";
import { assertRouteTableIsUnambiguous, matchRoute, type RouteMatch } from "./router.js";
import { isRecord } from "./validators.js";

export interface WebHandlerOptions {
	readonly basePath?: string;
	readonly clientAddress?: (request: Request) => string | null;
}

/** The same rule as S-COOKIE-5: a repeated name is rejected rather than one of its values chosen. */
function readQuery(url: URL): Record<string, string> {
	const query: Record<string, string> = {};
	for (const [name, value] of url.searchParams) {
		if (Object.hasOwn(query, name)) {
			throw new VelveError("invalid_input");
		}
		query[name] = value;
	}
	return query;
}

function requestUrl(request: Request): URL | null {
	try {
		return new URL(request.url);
	} catch {
		return null;
	}
}

async function readInput(request: Request, url: URL, match: RouteMatch): Promise<unknown> {
	if (match.route.method === "GET") {
		return { ...readQuery(url), ...match.pathParameters };
	}
	const text = await request.text();
	if (text === "") {
		return { ...match.pathParameters };
	}
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new VelveError("invalid_input");
	}
	if (!isRecord(body)) {
		throw new VelveError("invalid_input");
	}
	return { ...body, ...match.pathParameters };
}

function readRouteCall(
	request: Request,
	url: URL,
	match: RouteMatch,
	environment: HttpEnvironment,
	readClientAddress: (request: Request) => string | null,
): RouteCall {
	return {
		origin: request.headers.get("origin"),
		ipAddress: readClientAddress(request),
		userAgent: request.headers.get("user-agent"),
		readCallerTokens: () => {
			const cookies = readCookies(request.headers.get("cookie"), cookiePolicyOf(environment).names);
			return {
				sessionToken: cookies.session,
				// S-CACHE-4: only the four routes with caller "pending" ever see the pending cookie.
				pendingToken: match.route.caller === "pending" ? cookies.pending : null,
			};
		},
		readInput: () => readInput(request, url, match),
	};
}

interface ResponseParts {
	readonly body: unknown;
	readonly cookies: readonly CookieInstruction[];
}

/** 3.5: the plaintext token leaves the process in the cookie and never in the response body. */
function moveTokensIntoCookies(output: unknown, environment: HttpEnvironment): ResponseParts {
	if (!isRecord(output)) {
		return { body: output, cookies: [] };
	}
	const { sessionToken, pendingToken, ...body } = output;
	const collector = createCookieCollector(cookiePolicyOf(environment));
	if (typeof sessionToken === "string") {
		collector.setSession(sessionToken);
	}
	if (typeof pendingToken === "string") {
		collector.setPending(pendingToken);
	}
	return { body, cookies: collector.collect() };
}

function lastInstructionPerCookie(
	...groups: readonly (readonly CookieInstruction[])[]
): readonly CookieInstruction[] {
	const byName = new Map<string, CookieInstruction>();
	for (const instruction of groups.flat()) {
		byName.set(instruction.name, instruction);
	}
	return [...byName.values()];
}

function toResponse(outcome: RouteOutcome<unknown>, environment: HttpEnvironment): Response {
	const parts = moveTokensIntoCookies(outcome.output, environment);
	const cookies = lastInstructionPerCookie(parts.cookies, outcome.cookies);
	assertCookieNamesAreEnumerated(cookies);
	const redirectPath = readRedirectPath(parts.body);

	if (redirectPath !== null) {
		return redirectResponse(redirectPath, cookies);
	}
	return parts.body === undefined
		? bodilessResponse(204, cookies)
		: jsonResponse(200, parts.body, cookies);
}

export function toWebHandler(
	auth: WebHandlerTarget,
	options: WebHandlerOptions = {},
): (request: Request) => Promise<Response> {
	const environment = auth.http;
	assertRouteTableIsUnambiguous(environment.routes);
	const basePath = options.basePath ?? "";
	const readClientAddress = options.clientAddress ?? (() => null);

	return async (request) => {
		const url = requestUrl(request);
		const match =
			url === null ? null : matchRoute(environment.routes, request.method, url.pathname, basePath);
		if (url === null || match === null) {
			return bodilessResponse(404, []);
		}
		try {
			const call = readRouteCall(request, url, match, environment, readClientAddress);
			return toResponse(await runRoute(match.route, call, environment), environment);
		} catch (cause) {
			return errorResponse(toLoggedFailure(cause, match.route.name, environment), []);
		}
	};
}
