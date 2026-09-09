import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from "jose";
import { ConcealedError, VelveError } from "../http/error-map.js";
import { equalsInConstantTime } from "../keys/index.js";
import { fetchJsonFromProvider, type OutboundFetch } from "./outbound.js";
import type { ResolvedProvider } from "./providers.js";

/**
 * S-KEY-7: the enumerated list an ID token's `alg` has to be in. It holds asymmetric algorithms
 * only, so `none` and every HMAC family are refused by not appearing — the discovery document of
 * GHSA-9h47-pqcx-hjr4 advertised `none` and was believed.
 */
export const ID_TOKEN_SIGNATURE_ALGORITHMS: readonly string[] = [
	"RS256",
	"RS384",
	"RS512",
	"PS256",
	"PS384",
	"PS512",
	"ES256",
	"ES384",
	"ES512",
	"EdDSA",
];

const CLOCK_TOLERANCE_IN_SECONDS = 5;

const utf8 = new TextEncoder();

function isKeySet(body: Record<string, unknown>): body is Record<string, unknown> & JSONWebKeySet {
	return Array.isArray(body.keys);
}

async function keySetOf(
	fetchImplementation: OutboundFetch,
	jwksUri: string,
): Promise<ReturnType<typeof createLocalJWKSet>> {
	const body = await fetchJsonFromProvider(fetchImplementation, { url: jwksUri, headers: {} });
	if (!isKeySet(body)) {
		throw new VelveError("oauth_provider_error");
	}
	try {
		return createLocalJWKSet(body);
	} catch {
		throw new VelveError("oauth_provider_error");
	}
}

function assertNonceMatches(claims: Record<string, unknown>, expected: string | null): void {
	if (expected === null) {
		return;
	}
	const presented = claims.nonce;
	if (
		typeof presented !== "string" ||
		!equalsInConstantTime(utf8.encode(presented), utf8.encode(expected))
	) {
		throw new ConcealedError("nonce_mismatch");
	}
}

/**
 * 3.10: the signature is checked against the provider's JWKS, the audience against the client id,
 * the issuer where the provider declares one, and the nonce against the flow row. A failure of any
 * of them is `oauth_flow_invalid` to the caller and its own reason in the log.
 */
export async function claimsOfIdToken(input: {
	readonly fetch: OutboundFetch;
	readonly provider: ResolvedProvider;
	readonly idToken: string;
	readonly nonce: string | null;
}): Promise<Record<string, unknown>> {
	const { provider } = input;
	if (provider.jwksUri === null) {
		throw new VelveError("oauth_provider_error");
	}
	const keys = await keySetOf(input.fetch, provider.jwksUri);

	let claims: Record<string, unknown>;
	try {
		const verified = await jwtVerify(input.idToken, keys, {
			algorithms: [...ID_TOKEN_SIGNATURE_ALGORITHMS],
			audience: provider.clientId,
			clockTolerance: CLOCK_TOLERANCE_IN_SECONDS,
			...(provider.issuer === null ? {} : { issuer: provider.issuer }),
		});
		claims = verified.payload as Record<string, unknown>;
	} catch {
		throw new ConcealedError("id_token_signature_invalid");
	}

	assertNonceMatches(claims, input.nonce);
	return claims;
}
