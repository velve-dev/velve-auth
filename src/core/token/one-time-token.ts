import type { OneTimeTokenRepository } from "../db/repositories/token.js";
import type { OneTimeTokenPayload, OneTimeTokenPurpose } from "./purpose.js";
import { createSecretToken, hashSecretToken, type SecretToken } from "./secret-token.js";

export interface OneTimeTokenRequest {
	readonly purpose: OneTimeTokenPurpose;
	readonly userId: string;
	readonly payload?: OneTimeTokenPayload;
}

export interface IssuedOneTimeToken {
	readonly token: SecretToken;
	readonly expiresAt: string;
}

export interface OneTimeTokenRedemption {
	readonly purpose: OneTimeTokenPurpose;
	readonly userId: string;
	readonly payload: OneTimeTokenPayload | null;
}

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
			return { purpose, userId: stored.userId, payload: stored.payload };
		},
	};
}
