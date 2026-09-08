import { type CookieInstruction, serializeCookie } from "./cookies.js";
import { toErrorBody, type VelveError } from "./error-map.js";

function headersWith(cookies: readonly CookieInstruction[], contentType: string | null): Headers {
	const headers = new Headers();
	// L-6: an upstream cache the library knows nothing about is the normal case.
	headers.set("Cache-Control", "no-store");
	headers.set("Vary", "Cookie");
	if (contentType !== null) {
		headers.set("Content-Type", contentType);
	}
	for (const cookie of cookies) {
		headers.append("Set-Cookie", serializeCookie(cookie));
	}
	return headers;
}

export function jsonResponse(
	status: number,
	body: unknown,
	cookies: readonly CookieInstruction[],
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: headersWith(cookies, "application/json"),
	});
}

export function bodilessResponse(status: number, cookies: readonly CookieInstruction[]): Response {
	return new Response(null, { status, headers: headersWith(cookies, null) });
}

// H13: the wait is a header per RFC 9110 as well as a body field, so an intermediary can act on it.
export function errorResponse(error: VelveError, cookies: readonly CookieInstruction[]): Response {
	const response = jsonResponse(error.httpStatus, toErrorBody(error), cookies);
	if (error.retryAfterSeconds !== undefined) {
		response.headers.set("Retry-After", String(Math.ceil(error.retryAfterSeconds)));
	}
	return response;
}

export function redirectResponse(path: string, cookies: readonly CookieInstruction[]): Response {
	const headers = headersWith(cookies, null);
	headers.set("Location", path);
	return new Response(null, { status: 302, headers });
}
