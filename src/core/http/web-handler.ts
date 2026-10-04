import { resolveClientAddress } from "../limit/client-address.js";
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
import type { RouteMetadata } from "./route.js";
import { assertRouteTableIsUnambiguous, matchRoute, type RouteMatch } from "./router.js";
import { isRecord } from "./validators.js";

export interface WebHandlerOptions {
	readonly basePath?: string;
	/** the address the connection came from, which the adapter supplies as a `Request` lacks it */
	readonly connectionAddress?: (request: Request) => string | null;
}

//a repeated query name must be rejected rather than one of its values chosen
function readQuery(url: URL): Record<string, string> {
	const query: Record<string, string> = Object.create(null);
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

//a repeated form name must be refused rather than one of its values chosen
function readForm(text: string): Record<string, string> {
	const fields: Record<string, string> = Object.create(null);
	for (const [name, value] of new URLSearchParams(text)) {
		if (Object.hasOwn(fields, name)) {
			throw new VelveError("invalid_input");
		}
		fields[name] = value;
	}
	return fields;
}

//a name carried by two sources must be refused even when both values agree (S-OWNER-6)
function mergeSources(
	sources: readonly Readonly<Record<string, unknown>>[],
): Record<string, unknown> {
	const merged: Record<string, unknown> = Object.create(null);
	for (const source of sources) {
		for (const name of Object.keys(source)) {
			if (Object.hasOwn(merged, name)) {
				throw new VelveError("invalid_input");
			}
			merged[name] = source[name];
		}
	}
	return merged;
}

async function readBody(request: Request, match: RouteMatch): Promise<Record<string, unknown>> {
	const text = await request.text();
	//the form_post callback is posted by the provider, not by the application
	if (match.route.requestBody === "form") {
		return readForm(text);
	}
	if (text === "") {
		return {};
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
	return body;
}

//a post reads no parameter from its query yet refuses one the body or the path also carries (S-OWNER-6)
function refuseQueryNamesIn(url: URL, input: Readonly<Record<string, unknown>>): void {
	for (const name of url.searchParams.keys()) {
		if (Object.hasOwn(input, name)) {
			throw new VelveError("invalid_input");
		}
	}
}

async function readInput(request: Request, url: URL, match: RouteMatch): Promise<unknown> {
	if (match.route.method === "GET") {
		return mergeSources([readQuery(url), match.pathParameters]);
	}
	const input = mergeSources([await readBody(request, match), match.pathParameters]);
	refuseQueryNamesIn(url, input);
	return input;
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
			//which route may see which cookie is decided in route.ts and nowhere else (E-335)
			return {
				sessionToken: cookies.session,
				pendingToken: cookies.pending,
				oauthStateToken: cookies.oauthState,
			};
		},
		readInput: () => readInput(request, url, match),
	};
}

interface ResponseParts {
	readonly body: unknown;
	readonly cookies: readonly CookieInstruction[];
}

//the plaintext token leaves the process in the cookie and never in the response body
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

function toResponse(
	route: RouteMetadata,
	outcome: RouteOutcome<unknown>,
	environment: HttpEnvironment,
): Response {
	const parts = moveTokensIntoCookies(outcome.output, environment);
	const cookies = lastInstructionPerCookie(parts.cookies, outcome.cookies);
	assertCookieNamesAreEnumerated(cookies);
	const redirectPath = readRedirectPath(route, parts.body);

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
	const readConnectionAddress = options.connectionAddress ?? (() => null);
	//the forwarded header counts only where trustedProxies names who may write it (S-RATE-3)
	const readClientAddress = (request: Request): string | null =>
		resolveClientAddress(
			readConnectionAddress(request),
			request.headers.get("x-forwarded-for"),
			environment.trustedProxies,
		);

	return async (request) => {
		const url = requestUrl(request);
		const match =
			url === null ? null : matchRoute(environment.routes, request.method, url.pathname, basePath);
		if (url === null || match === null) {
			return bodilessResponse(404, []);
		}
		try {
			const call = readRouteCall(request, url, match, environment, readClientAddress);
			return toResponse(match.route, await runRoute(match.route, call, environment), environment);
		} catch (cause) {
			return errorResponse(toLoggedFailure(cause, match.route.name, environment), []);
		}
	};
}
