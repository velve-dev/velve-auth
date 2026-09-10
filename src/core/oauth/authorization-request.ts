import type { ResolvedProvider } from "./providers.js";

interface AuthorizationRequest {
	readonly provider: ResolvedProvider;
	readonly state: string;
	readonly codeChallenge: string;
	readonly nonce: string | null;
}

/**
 * 3.10 and S-REDIR-3: the URL is built from the provider's configured endpoint and handed back in
 * the response body, never as a `Location`. PKCE S256 is written unconditionally — there is no
 * branch that leaves it out and none that downgrades it to `plain` (GHSA-9h47-pqcx-hjr4).
 */
export function authorizationUrlFor(request: AuthorizationRequest): string {
	const { provider } = request;
	const url = new URL(provider.authorizationEndpoint);
	const parameters = url.searchParams;

	parameters.set("response_type", "code");
	parameters.set("client_id", provider.clientId);
	parameters.set("redirect_uri", provider.redirectUri);
	parameters.set("state", request.state);
	parameters.set("code_challenge", request.codeChallenge);
	parameters.set("code_challenge_method", "S256");
	if (provider.scopes.length > 0) {
		parameters.set("scope", provider.scopes.join(" "));
	}
	if (request.nonce !== null) {
		parameters.set("nonce", request.nonce);
	}
	if (provider.prompt !== null) {
		parameters.set("prompt", provider.prompt);
	}
	if (provider.responseMode === "form_post") {
		parameters.set("response_mode", "form_post");
	}

	return url.toString();
}
