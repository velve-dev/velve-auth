import type { RedeemedOneTimeToken } from "../db/actor.js";
import type { OneTimeTokenRepository } from "../db/repositories/token.js";
import type { KeyProvider } from "../keys/provider.js";
import {
	bindToken,
	checkTokenBinding,
	reportRefusedTokenRow,
	type TokenBinding,
	type TokenBindingRefusalReport,
} from "./binding.js";
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

interface OneTimeTokenBindingOptions {
	readonly keys: KeyProvider;
	readonly reportTokenBindingRefusal?: TokenBindingRefusalReport;
}

export function createOneTimeTokens(
	repository: OneTimeTokenRepository,
	options: OneTimeTokenBindingOptions,
): OneTimeTokens {
	return {
		async issue(request) {
			const token = createSecretToken();
			const tokenSha256 = hashSecretToken(token);
			const payload = request.payload ?? null;
			const binding: TokenBinding = {
				purpose: request.purpose,
				ownerId: request.userId,
				tokenSha256,
				content: { payload },
			};
			const { expiresAt } = await repository.replaceOneTimeToken({
				...request,
				tokenSha256,
				payload,
				...(await bindToken(options.keys, binding)),
			});
			return { token, expiresAt };
		},

		//a row the library did not write is answered as no row before its owner is used (S-INTEG-9)
		async redeem({ token, purpose }) {
			const tokenSha256 = hashSecretToken(token);
			const candidate = await repository.consumeOneTimeToken({ tokenSha256, purpose });
			if (candidate === null) {
				return null;
			}
			const stored = candidate.storedPayload;
			const verdict =
				stored === null
					? "mismatch"
					: await checkTokenBinding(
							options.keys,
							{
								purpose,
								ownerId: candidate.userId,
								tokenSha256,
								content: { payload: stored.payload },
							},
							candidate,
						);
			if (verdict !== "valid") {
				reportRefusedTokenRow(options.reportTokenBindingRefusal, {
					userId: candidate.userId,
					occasion: "token_redemption",
					verdict,
				});
				return null;
			}
			return candidate.userId === null ? null : { ...candidate.accept(), purpose };
		},
	};
}
