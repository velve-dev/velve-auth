import type { RedeemedOneTimeToken } from "../db/actor.js";
import type { OneTimeTokenRepository } from "../db/repositories/token.js";
import type { OneTimeTokenPayload, OneTimeTokenPurpose, OneTimeTokenSubject } from "./purpose.js";
import { createSecretToken, hashSecretToken, type SecretToken } from "./secret-token.js";

/** a `userId` of null asks for the cover artefact an address naming no account is answered with */
export type OneTimeTokenRequest = {
	readonly purpose: OneTimeTokenPurpose;
	readonly payload?: OneTimeTokenPayload;
} & OneTimeTokenSubject;

export interface IssuedOneTimeToken {
	readonly token: SecretToken;
	readonly expiresAt: Date;
}

/** a redeemed token carrying the proof of ownership its removal produced */
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
		async issue(request) {
			const token = createSecretToken();
			const { expiresAt } = await repository.replaceOneTimeToken({
				...request,
				tokenSha256: hashSecretToken(token),
				payload: request.payload ?? null,
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
