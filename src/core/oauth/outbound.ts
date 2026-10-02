import { VelveError } from "../http/error-map.js";

//a provider that has not answered in ten seconds is an outage and the caller is waiting
const OUTBOUND_TIMEOUT_IN_MILLISECONDS = 10_000;

export type OutboundFetch = typeof globalThis.fetch;

interface OutboundRequest {
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: URLSearchParams;
}

const REDIRECT_STATUS_FLOOR = 300;
const REDIRECT_STATUS_CEILING = 399;

//a redirect from a provider must not steer the server at a host of its choosing (S-REDIR-6)
function assertNotARedirect(response: Response): Response {
	if (response.status >= REDIRECT_STATUS_FLOOR && response.status <= REDIRECT_STATUS_CEILING) {
		throw new VelveError("oauth_provider_error");
	}
	return response;
}

async function readJsonBody(response: Response): Promise<Record<string, unknown>> {
	if (!response.ok) {
		throw new VelveError("oauth_provider_error");
	}
	const text = await response.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new VelveError("oauth_provider_error");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new VelveError("oauth_provider_error");
	}
	return parsed as Record<string, unknown>;
}

async function call(
	fetchImplementation: OutboundFetch,
	request: OutboundRequest,
): Promise<Response> {
	const method = request.body === undefined ? "GET" : "POST";
	try {
		return assertNotARedirect(
			await fetchImplementation(request.url, {
				method,
				headers: { Accept: "application/json", ...request.headers },
				redirect: "manual",
				signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_IN_MILLISECONDS),
				...(request.body === undefined ? {} : { body: request.body }),
			}),
		);
	} catch (failure) {
		throw failure instanceof VelveError ? failure : new VelveError("oauth_provider_error");
	}
}

//every provider call goes through here and takes its URL from the configuration (S-REDIR-6)
export async function fetchJsonFromProvider(
	fetchImplementation: OutboundFetch,
	request: OutboundRequest,
): Promise<Record<string, unknown>> {
	return readJsonBody(await call(fetchImplementation, request));
}
