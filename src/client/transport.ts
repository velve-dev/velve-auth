import type { VelveErrorCode } from "../core/http/error-map.js";
import { type VelveFailure, type VelveResult, VelveTransportError } from "./result.js";
import type { ClientRoute } from "./routes.js";

const JSON_CONTENT_TYPE = "application/json";

export interface VelveClientOptions {
	readonly baseURL: string;
	readonly fetch?: typeof globalThis.fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function endpointOf(baseURL: string, path: string): string {
	return baseURL.endsWith("/") ? `${baseURL.slice(0, -1)}${path}` : `${baseURL}${path}`;
}

interface AddressedRoute {
	readonly path: string;
	readonly rest: Readonly<Record<string, unknown>>;
}

//the probe host must name no domain and never read as an invented address (S-LINK-5)
const PATH_NORMALISATION_PROBE = "https://velve-auth";

//a dot segment in a path value must not consume the segment it was meant to fill
function assertPathIsStillTheRoutes(route: ClientRoute, path: string): void {
	if (new URL(path, PATH_NORMALISATION_PROBE).pathname !== path) {
		throw new TypeError(`Route ${route.name} was given a path parameter that changes its path`);
	}
}

//a path field must be carried in exactly one place and not repeated in query or body
function addressOf(route: ClientRoute, input: unknown): AddressedRoute {
	const fields = isRecord(input) ? { ...input } : {};
	const segments = route.path.split("/").map((segment) => {
		if (!segment.startsWith(":")) {
			return segment;
		}
		const name = segment.slice(1);
		const value = fields[name];
		if (typeof value !== "string" || value === "") {
			throw new TypeError(
				`Route ${route.name} needs a non-empty string ${name} to address its path`,
			);
		}
		delete fields[name];
		return encodeURIComponent(value);
	});
	const path = segments.join("/");
	assertPathIsStillTheRoutes(route, path);
	return { path, rest: fields };
}

function queryOf(fields: Readonly<Record<string, unknown>>): string {
	const parameters = new URLSearchParams();
	for (const [name, value] of Object.entries(fields)) {
		if (value !== undefined) {
			parameters.set(name, String(value));
		}
	}
	const query = parameters.toString();
	return query === "" ? "" : `?${query}`;
}

function requestInitOf(route: ClientRoute, addressed: AddressedRoute): RequestInit {
	const envelope = {
		//the method must be the row's so no state change is reachable with a get (S-CSRF-4)
		method: route.method,
		//the session cookie must ride along and the origin header is left to the browser
		credentials: "include",
		//a cache must not answer before the no store header of the answer is read (S-CACHE-1)
		cache: "no-store",
		//a call must never follow a redirect as the only one belongs to a navigation (S-REDIR-3)
		redirect: "manual",
	} as const;
	return route.method === "GET"
		? envelope
		: {
				...envelope,
				headers: { "Content-Type": JSON_CONTENT_TYPE },
				body: JSON.stringify(addressed.rest),
			};
}

async function answerTo(
	send: typeof globalThis.fetch,
	baseURL: string,
	route: ClientRoute,
	addressed: AddressedRoute,
): Promise<Response> {
	const query = route.method === "GET" ? queryOf(addressed.rest) : "";
	try {
		return await send(
			`${endpointOf(baseURL, addressed.path)}${query}`,
			requestInitOf(route, addressed),
		);
	} catch (cause) {
		throw new VelveTransportError(`The call to ${route.name} did not reach the server`, cause);
	}
}

async function readAnswer(route: ClientRoute, response: Response): Promise<string> {
	try {
		return await response.text();
	} catch (cause) {
		throw new VelveTransportError(`The answer to ${route.name} could not be read`, cause);
	}
}

function parsedAnswer(route: ClientRoute, text: string): unknown {
	try {
		return JSON.parse(text);
	} catch (cause) {
		throw new VelveTransportError(`The answer to ${route.name} was not a Velve response`, cause);
	}
}

//the wire carries a code the route declaration has already narrowed
function failureIn(body: unknown): VelveFailure<VelveErrorCode> | null {
	if (!isRecord(body) || !isRecord(body.error)) {
		return null;
	}
	const { code, message, retryAfterSeconds } = body.error;
	if (typeof code !== "string" || typeof message !== "string") {
		return null;
	}
	const failure = { code: code as VelveErrorCode, message };
	return typeof retryAfterSeconds === "number" ? { ...failure, retryAfterSeconds } : failure;
}

function refusedAnswer(
	route: ClientRoute,
	status: number,
	text: string,
): VelveFailure<VelveErrorCode> {
	const failure = text === "" ? null : failureIn(parsedAnswer(route, text));
	if (failure === null) {
		throw new VelveTransportError(`The answer to ${route.name} was not a Velve response`, status);
	}
	return failure;
}

export type RouteCall = (
	route: ClientRoute,
	input: unknown,
) => Promise<VelveResult<unknown, VelveErrorCode>>;

export function createRouteCall(options: VelveClientOptions): RouteCall {
	const send = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
	return async (route, input) => {
		const response = await answerTo(send, options.baseURL, route, addressOf(route, input));
		const text = await readAnswer(route, response);
		return response.ok
			? { ok: true, value: text === "" ? undefined : parsedAnswer(route, text) }
			: { ok: false, error: refusedAnswer(route, response.status, text) };
	};
}
