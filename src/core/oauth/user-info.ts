import { VelveError } from "../http/error-map.js";
import { fetchJsonFromProvider, type OutboundFetch } from "./outbound.js";
import type { ResolvedProvider } from "./providers.js";

/**
 * The second of the two ways a provider names an account, for the ones that issue no ID token. The
 * endpoint comes from the descriptor or the configuration and from nowhere else (S-REDIR-6).
 */
export async function claimsFromUserInfo(input: {
	readonly fetch: OutboundFetch;
	readonly provider: ResolvedProvider;
	readonly accessToken: string | null;
}): Promise<Record<string, unknown>> {
	const { provider } = input;
	if (provider.userInfoEndpoint === null || input.accessToken === null) {
		throw new VelveError("oauth_provider_error");
	}
	return fetchJsonFromProvider(input.fetch, {
		url: provider.userInfoEndpoint,
		headers: { Authorization: `Bearer ${input.accessToken}`, ...provider.userInfoHeaders },
	});
}
