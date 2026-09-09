import { VelveError } from "../http/error-map.js";
import { fetchJsonFromProvider, type OutboundFetch } from "./outbound.js";
import type { ResolvedProvider } from "./providers.js";

export interface ProviderTokens {
	readonly accessToken: string | null;
	readonly refreshToken: string | null;
	readonly idToken: string | null;
	readonly scopes: readonly string[];
	readonly expiresInSeconds: number | null;
}

function readString(body: Record<string, unknown>, field: string): string | null {
	const value = body[field];
	return typeof value === "string" && value !== "" ? value : null;
}

function readScopes(body: Record<string, unknown>, provider: ResolvedProvider): readonly string[] {
	const granted = readString(body, "scope");
	return granted === null ? provider.scopes : granted.split(" ").filter((scope) => scope !== "");
}

function readLifetime(body: Record<string, unknown>): number | null {
	const value = body.expires_in;
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.trunc(value);
	}
	const parsed = typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
	return Number.isNaN(parsed) ? null : parsed;
}

/**
 * RFC 6749 §4.1.3 with the PKCE verifier of RFC 7636. The credentials travel in the body rather
 * than in an `Authorization` header because Apple's client secret is a JWT and every provider of
 * 3.10 accepts `client_secret_post`.
 */
export async function exchangeAuthorizationCode(input: {
	readonly fetch: OutboundFetch;
	readonly provider: ResolvedProvider;
	readonly code: string;
	readonly codeVerifier: string;
}): Promise<ProviderTokens> {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code: input.code,
		redirect_uri: input.provider.redirectUri,
		code_verifier: input.codeVerifier,
		client_id: input.provider.clientId,
		client_secret: input.provider.clientSecret,
	});

	const answer = await fetchJsonFromProvider(input.fetch, {
		url: input.provider.tokenEndpoint,
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});

	const accessToken = readString(answer, "access_token");
	const idToken = readString(answer, "id_token");
	if (accessToken === null && idToken === null) {
		throw new VelveError("oauth_provider_error");
	}

	return {
		accessToken,
		idToken,
		refreshToken: readString(answer, "refresh_token"),
		scopes: readScopes(answer, input.provider),
		expiresInSeconds: readLifetime(answer),
	};
}
