import type { RedeemedOneTimeToken } from "../db/actor.js";
import type { OneTimeTokenRepository } from "../db/repositories/token.js";
import type { OneTimeTokenPayload, OneTimeTokenPurpose } from "./purpose.js";
import { createSecretToken, hashSecretToken, type SecretToken } from "./secret-token.js";

export interface OneTimeTokenRequest {
	readonly purpose: OneTimeTokenPurpose;
	/** `null` asks for the cover artefact an address that names no account is answered with (E-597). */
	readonly userId: string | null;
	readonly payload?: OneTimeTokenPayload;
}

export interface IssuedOneTimeToken {
	readonly token: SecretToken;
	readonly expiresAt: Date;
}

/**
 * E-234: the removal is what proved the owner, so the redemption carries that provenance rather
 * than a bare string, and `actorOfRedeemedOneTimeToken` is reachable from it without a cast.
 */
export type OneTimeTokenRedemption = RedeemedOneTimeToken & {
	readonly purpose: OneTimeTokenPurpose;
	readonly payload: OneTimeTokenPayload | null;
};

export interface OneTimeTokens {
	issue(request: OneTimeTokenRequest): Promise<IssuedOneTimeToken>;
	redeem(attempt: {
		token: SecretToken;
		purpose: OneTimeTokenPurpose;
	}): Promise<OneTimeTokenRedemption | null>;
}

export function createOneTimeTokens(repository: OneTimeTokenRepository): OneTimeTokens {
	return {
		async issue({ purpose, userId, payload }) {
			const token = createSecretToken();
			const { expiresAt } = await repository.replaceOneTimeToken({
				tokenSha256: hashSecretToken(token),
				purpose,
				userId,
				payload: payload ?? null,
			});
			return { token, expiresAt };
		},

		async redeem({ token, purpose }) {
			const stored = await repository.consumeOneTimeToken({
				tokenSha256: hashSecretToken(token),
				purpose,
			});
			if (stored === null) {
				return null;
			}
			return { ...stored, purpose };
		},
	};
}
