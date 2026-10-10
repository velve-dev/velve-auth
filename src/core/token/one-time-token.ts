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
	/** what the account's token generation must still be at, and what moves it */
	readonly spent: SpentToken;
};

/** the token a redemption spent, which the account's token generation must still be at when it takes effect */
export interface SpentToken {
	readonly purpose: OneTimeTokenPurpose;
	readonly tokenSha256: Uint8Array;
	readonly tokenGeneration: number | null;
}

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

const TOKEN_GENERATION = "tokenGeneration";

//the generation a link binds travels in its payload under the mac like the address it was mailed to (E-3522)
function payloadUnder(
	payload: OneTimeTokenPayload | null,
	tokenGeneration: number | null,
): OneTimeTokenPayload | null {
	return tokenGeneration === null ? payload : { ...payload, [TOKEN_GENERATION]: tokenGeneration };
}

function tokenGenerationIn(payload: OneTimeTokenPayload | null): number | null {
	const generation = payload?.[TOKEN_GENERATION];
	return typeof generation === "number" && Number.isSafeInteger(generation) ? generation : null;
}

//the generation is the library's own and the caller gets back the payload it issued
function payloadAsIssued(payload: OneTimeTokenPayload | null): OneTimeTokenPayload | null {
	if (payload === null || !(TOKEN_GENERATION in payload)) {
		return payload;
	}
	const { [TOKEN_GENERATION]: _bound, ...issued } = payload;
	return Object.keys(issued).length === 0 ? null : issued;
}

export function createOneTimeTokens(
	repository: OneTimeTokenRepository,
	options: OneTimeTokenBindingOptions,
): OneTimeTokens {
	return {
		async issue(request) {
			const token = createSecretToken();
			const tokenSha256 = hashSecretToken(token);
			const { expiresAt } = await repository.replaceOneTimeToken({
				...request,
				tokenSha256,
				bindUnder: async (tokenGeneration) => {
					const payload = payloadUnder(request.payload ?? null, tokenGeneration);
					const binding: TokenBinding = {
						purpose: request.purpose,
						ownerId: request.userId,
						tokenSha256,
						content: { payload },
					};
					return { payload, ...(await bindToken(options.keys, binding)) };
				},
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
			if (candidate.userId === null) {
				return null;
			}
			const accepted = candidate.accept();
			return {
				...accepted,
				payload: payloadAsIssued(accepted.payload),
				purpose,
				spent: { purpose, tokenSha256, tokenGeneration: tokenGenerationIn(accepted.payload) },
			};
		},
	};
}
