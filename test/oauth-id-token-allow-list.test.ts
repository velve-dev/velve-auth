import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, jwtVerify, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { claimsOfIdToken, ID_TOKEN_SIGNATURE_ALGORITHMS } from "../src/core/oauth/id-token.js";
import type { ResolvedProvider } from "../src/core/oauth/providers.js";

/**
 * S-KEY-7 asks for asymmetric algorithms from an enumerated list. `jose` already refuses `none`
 * and every HMAC for a JSON Web Key Set, and an `oct` key in the set as well, so a test built from
 * those stays green with the list removed. What only the list refuses is an asymmetric algorithm
 * `jose` supports and the list does not name: `Ed25519`, the fully specified name RFC 9864 gives
 * the curve `EdDSA` stands for, with an `OKP` key the provider's set publishes. The first case
 * shows `jose` accepts that token without the list, so the second is not green for another reason.
 */

const ISSUER = "https://provider.example";
const CLIENT_ID = "velve-test-client";
const JWKS_URI = `${ISSUER}/jwks`;

const PROVIDER: ResolvedProvider = {
	id: "stubby",
	clientId: CLIENT_ID,
	clientSecret: "client-secret",
	authorizationEndpoint: `${ISSUER}/authorize`,
	tokenEndpoint: `${ISSUER}/token`,
	userInfoEndpoint: null,
	userInfoHeaders: {},
	issuer: ISSUER,
	jwksUri: JWKS_URI,
	subjectClaim: "sub",
	emailClaim: "email",
	emailVerifiedClaim: "email_verified",
	scopes: ["openid"],
	redirectUri: "https://api.example.com/sign-in/oauth/callback/stubby",
	prompt: null,
	responseMode: "query",
	trustedForAutomaticLinking: false,
};

function servingKeys(keys: readonly JWK[]): typeof globalThis.fetch {
	return (input) => {
		const url = typeof input === "string" ? input : String(input);
		if (url !== JWKS_URI) {
			return Promise.resolve(new Response("not found", { status: 404 }));
		}
		return Promise.resolve(
			new Response(JSON.stringify({ keys }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
	};
}

interface PublishedKeys {
	readonly keys: JWK[];
	readonly signWithRsa: () => Promise<string>;
	readonly signWithAnUnlistedAlgorithm: () => Promise<string>;
}

async function publishedKeys(): Promise<PublishedKeys> {
	const rsa = await generateKeyPair("RS256", { extractable: true });
	const edwards = await generateKeyPair("Ed25519", { extractable: true });
	const keys = [
		{ ...(await exportJWK(rsa.publicKey)), kid: "stub", alg: "RS256" },
		{ ...(await exportJWK(edwards.publicKey)), kid: "edwards" },
	];
	return {
		keys,
		signWithRsa: () => tokenSigned("RS256", "stub", rsa.privateKey),
		signWithAnUnlistedAlgorithm: () => tokenSigned("Ed25519", "edwards", edwards.privateKey),
	};
}

function tokenSigned(alg: string, kid: string, key: CryptoKey): Promise<string> {
	return new SignJWT({ sub: "subject" })
		.setProtectedHeader({ alg, kid })
		.setIssuer(ISSUER)
		.setAudience(CLIENT_ID)
		.setIssuedAt()
		.setExpirationTime("5m")
		.sign(key);
}

describe("S-KEY-7: an asymmetric algorithm the list does not name is refused", () => {
	it("is refused by the list and not by jose, which verifies the token without it", async () => {
		const { keys, signWithAnUnlistedAlgorithm } = await publishedKeys();

		const verified = await jwtVerify(
			await signWithAnUnlistedAlgorithm(),
			createLocalJWKSet({ keys }),
			{
				audience: CLIENT_ID,
				issuer: ISSUER,
			},
		);

		expect(ID_TOKEN_SIGNATURE_ALGORITHMS).not.toContain("Ed25519");
		expect(verified.protectedHeader.alg).toBe("Ed25519");
	});

	it("refuses the Ed25519 token from the provider's own set and accepts the RS256 one", async () => {
		const { keys, signWithRsa, signWithAnUnlistedAlgorithm } = await publishedKeys();
		const fetch = servingKeys(keys);

		const accepted = await claimsOfIdToken({
			fetch,
			provider: PROVIDER,
			idToken: await signWithRsa(),
			nonce: null,
		});

		expect(accepted.sub).toBe("subject");
		await expect(
			claimsOfIdToken({
				fetch,
				provider: PROVIDER,
				idToken: await signWithAnUnlistedAlgorithm(),
				nonce: null,
			}),
		).rejects.toMatchObject({ reason: "id_token_signature_invalid" });
	});
});
