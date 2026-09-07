import {
	assertCookieNamesAreEnumerated,
	type CookieInstruction,
	createCookieCollector,
	readCookies,
} from "./cookies.js";
import { cookiePolicyOf, type HttpEnvironment, type WebHandlerTarget } from "./environment.js";
import { toErrorBody, toVisibleFailure, VelveError } from "./error-map.js";
import { type RouteCall, type RouteOutcome, runRoute } from "./pipeline.js";
import { bodilessResponse, jsonResponse } from "./response.js";
import { matchRoute, type RouteMatch } from "./router.js";
import { isRecord } from "./validators.js";

export interface WebHandlerOptions {
	readonly basePath?: string;
	readonly clientAddress?: (request: Request) => string | null;
}

async function readInput(request: Request, match: RouteMatch): Promise<unknown> {
	if (match.route.method === "GET") {
		const query = Object.fromEntries(new URL(request.url).searchParams);
		return { ...query, ...match.pathParameters };
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
		readInput: () => readInput(request, match),
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

	return parts.body === undefined
		? bodilessResponse(204, cookies)
		: jsonResponse(200, parts.body, cookies);
}

export function toWebHandler(
	auth: WebHandlerTarget,
	options: WebHandlerOptions = {},
): (request: Request) => Promise<Response> {
	const environment = auth.http;
	const basePath = options.basePath ?? "";
	const readClientAddress = options.clientAddress ?? (() => null);

	return async (request) => {
		const match = matchRoute(
			environment.routes,
			request.method,
			new URL(request.url).pathname,
			basePath,
		);
		if (match === null) {
			return bodilessResponse(404, []);
		}
		try {
			const call = readRouteCall(request, match, environment, readClientAddress);
			return toResponse(await runRoute(match.route, call, environment), environment);
		} catch (cause) {
			const failure = toVisibleFailure(cause);
			environment.log(failure.error.httpStatus >= 500 ? "error" : "warn", "request rejected", {
				route: match.route.name,
				reason: failure.loggedReason,
			});
			return jsonResponse(failure.error.httpStatus, toErrorBody(failure.error), []);
		}
	};
}
