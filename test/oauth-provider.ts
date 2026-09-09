import { exportJWK, generateKeyPair, type JWK, type KeyObject, SignJWT } from "jose";
import type { OAuthConfig } from "../src/core/oauth/config.js";

const PROVIDER_ORIGIN = "https://provider.example";
export const CALLBACK_BASE_URL = "https://api.example.com/sign-in/oauth/callback";
const CLIENT_ID = "velve-test-client";

interface KeyPair {
	readonly privateKey: KeyObject | CryptoKey;
	readonly publicJwk: JWK;
}

export interface ProviderClaims {
	readonly sub: string;
	readonly email?: string;
	/** `unknown`, because a case that spells the flag `"true"` or `1` is one this suite has to send. */
	readonly email_verified?: unknown;
	readonly [claim: string]: unknown;
}

interface StubProviderOptions {
	readonly claims: ProviderClaims;
	/** Absent means the provider issues no ID token and the claims come from `userinfo`. */
	readonly openIdConnect?: boolean;
	readonly accessToken?: string;
	readonly refreshToken?: string;
	readonly expiresInSeconds?: number;
}

export interface StubProvider {
	readonly fetch: typeof globalThis.fetch;
	readonly calls: readonly string[];
	/** Signs an ID token with the key the JWKS publishes, or with the algorithm a test names. */
	signIdToken(input: {
		readonly claims: Record<string, unknown>;
		readonly nonce?: string;
		readonly algorithm?: string;
		readonly foreignKey?: boolean;
	}): Promise<string>;
	replaceIdToken(idToken: string | null): void;
	/** A second account at the same provider, which is what a link collision needs. */
	reportClaims(claims: ProviderClaims): void;
	/** Section 1 C61: the token endpoint answers 3xx, which the library must refuse rather than follow. */
	answerTokenEndpointWithARedirect(): void;
	/** What the library asked for on each call, so that `redirect: "manual"` is observable. */
	readonly redirectModes: readonly (string | undefined)[];
}

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

export async function createStubProvider(options: StubProviderOptions): Promise<StubProvider> {
	const signing = await generateKeyPair("RS256", { extractable: true });
	const foreign = await generateKeyPair("RS256", { extractable: true });
	const keys: KeyPair = {
		privateKey: signing.privateKey,
		publicJwk: { ...(await exportJWK(signing.publicKey)), kid: "stub", alg: "RS256" },
	};
	const calls: string[] = [];
	const redirectModes: (string | undefined)[] = [];
	let overriddenIdToken: string | null | undefined;
	let reported: ProviderClaims = options.claims;
	let tokenEndpointRedirects = false;

	/** `alg: none` cannot be produced by a signer, so the one that must be refused is written by hand. */
	function unsignedToken(payload: Record<string, unknown>): string {
		const segment = (part: unknown): string =>
			Buffer.from(JSON.stringify(part)).toString("base64url");
		return `${segment({ alg: "none", typ: "JWT" })}.${segment(payload)}.`;
	}

	async function signIdToken(input: {
		claims: Record<string, unknown>;
		nonce?: string;
		algorithm?: string;
		foreignKey?: boolean;
	}): Promise<string> {
		const payload =
			input.nonce === undefined ? input.claims : { ...input.claims, nonce: input.nonce };
		if (input.algorithm === "none") {
			const now = Math.floor(Date.now() / 1000);
			return unsignedToken({
				...payload,
				iss: PROVIDER_ORIGIN,
				aud: CLIENT_ID,
				iat: now,
				exp: now + 300,
			});
		}
		const signer = new SignJWT(payload)
			.setProtectedHeader({ alg: input.algorithm ?? "RS256", kid: "stub" })
			.setIssuer(PROVIDER_ORIGIN)
			.setAudience(CLIENT_ID)
			.setIssuedAt()
			.setExpirationTime("5m");
		if (input.algorithm === "HS256") {
			return signer.sign(new TextEncoder().encode("a-symmetric-key-the-library-must-refuse"));
		}
		return signer.sign(input.foreignKey === true ? foreign.privateKey : keys.privateKey);
	}

	async function idTokenFor(code: string): Promise<string | null> {
		if (overriddenIdToken !== undefined) {
			return overriddenIdToken;
		}
		if (options.openIdConnect !== true) {
			return null;
		}
		const nonce = pendingNonceOf(code);
		return signIdToken({ claims: reported, ...(nonce === null ? {} : { nonce }) });
	}

	async function tokenEndpoint(init: RequestInit | undefined): Promise<Response> {
		if (tokenEndpointRedirects) {
			return new Response(null, {
				status: 302,
				headers: { Location: "https://relocated.example/token" },
			});
		}
		const body = new URLSearchParams(String(init?.body ?? ""));
		const idToken = await idTokenFor(body.get("code") ?? "");
		return json({
			access_token: options.accessToken ?? "provider-access-token",
			refresh_token: options.refreshToken ?? "provider-refresh-token",
			token_type: "Bearer",
			expires_in: options.expiresInSeconds ?? 3600,
			scope: "openid email",
			...(idToken === null ? {} : { id_token: idToken }),
		});
	}

	const fetchImplementation: typeof globalThis.fetch = async (input, init) => {
		const url = typeof input === "string" ? input : String(input);
		calls.push(url);
		redirectModes.push(init?.redirect);

		if (url.startsWith(`${PROVIDER_ORIGIN}/token`)) {
			return tokenEndpoint(init);
		}
		if (url.startsWith(`${PROVIDER_ORIGIN}/userinfo`)) {
			return json(reported);
		}
		if (url.startsWith(`${PROVIDER_ORIGIN}/jwks`)) {
			return json({ keys: [keys.publicJwk] });
		}
		return new Response("not found", { status: 404 });
	};

	return {
		fetch: fetchImplementation,
		get calls() {
			return calls;
		},
		signIdToken,
		replaceIdToken: (idToken) => {
			overriddenIdToken = idToken;
		},
		reportClaims: (claims) => {
			reported = claims;
		},
		answerTokenEndpointWithARedirect: () => {
			tokenEndpointRedirects = true;
		},
		get redirectModes() {
			return redirectModes;
		},
	};
}

/**
 * The authorization code a test hands back carries the nonce the library minted, because a real
 * provider echoes it into the ID token and the library refuses one that does not match.
 */
const NONCE_BY_CODE = new Map<string, string>();

export function codeCarrying(nonce: string | null): string {
	const code = `code-${NONCE_BY_CODE.size}-${Math.trunc(Math.random() * 1e9)}`;
	if (nonce !== null) {
		NONCE_BY_CODE.set(code, nonce);
	}
	return code;
}

function pendingNonceOf(code: string): string | null {
	return NONCE_BY_CODE.get(code) ?? null;
}

export function oauthConfigFor(input: {
	readonly openIdConnect: boolean;
	readonly trusted?: boolean;
	readonly storeTokens?: boolean;
	readonly responseMode?: "query" | "form_post";
}): OAuthConfig {
	return {
		providers: {
			stubby: {
				clientId: CLIENT_ID,
				clientSecret: "client-secret",
				authorizationEndpoint: `${PROVIDER_ORIGIN}/authorize`,
				tokenEndpoint: `${PROVIDER_ORIGIN}/token`,
				userInfoEndpoint: `${PROVIDER_ORIGIN}/userinfo`,
				subjectClaim: "sub",
				emailClaim: "email",
				emailVerifiedClaim: "email_verified",
				...(input.openIdConnect
					? { issuer: PROVIDER_ORIGIN, jwksUri: `${PROVIDER_ORIGIN}/jwks` }
					: {}),
				...(input.responseMode === undefined ? {} : { responseMode: input.responseMode }),
			},
		},
		callbackBaseUrl: CALLBACK_BASE_URL,
		trustedProviders: input.trusted === true ? ["stubby"] : [],
		...(input.storeTokens === undefined ? {} : { storeTokens: input.storeTokens }),
	};
}
