import type { EmailConfig, EmailMessage } from "../auth/config.js";
import type { Driver } from "../db/driver.js";
import { createOneTimeTokenRepository } from "../db/repositories/token.js";
import { ConcealedError } from "../http/error-map.js";
import {
	createOneTimeTokens,
	type IssuedOneTimeToken,
	type OneTimeTokenRedemption,
} from "../token/one-time-token.js";
import type {
	OneTimeTokenPayload,
	OneTimeTokenPurpose,
	OneTimeTokenSubject,
} from "../token/purpose.js";
import { toSecretToken } from "../token/secret-token.js";

export interface MintedArtefact extends IssuedOneTimeToken {
	readonly purpose: OneTimeTokenPurpose;
}

//an address that names no account must mint a row too and cost the same statements (E-597)
export async function mintArtefact(
	transaction: Driver,
	schema: string,
	request: {
		readonly purpose: OneTimeTokenPurpose;
		readonly subject: OneTimeTokenSubject;
		readonly payload?: OneTimeTokenPayload;
	},
): Promise<MintedArtefact> {
	const issued = await createOneTimeTokens(
		createOneTimeTokenRepository({ driver: transaction, schema }),
	).issue({
		...request.subject,
		purpose: request.purpose,
		...(request.payload === undefined ? {} : { payload: request.payload }),
	});
	return { ...issued, purpose: request.purpose };
}

//a request for an unknown address must wait where a request for an account waits (E-931)
export function subjectOfAddress(
	owner: { readonly id: string } | null,
	address: string,
): OneTimeTokenSubject {
	return owner === null ? { userId: null, serialisedOn: address } : { userId: owner.id };
}

export interface ArtefactMailer {
	readonly driver: Driver;
	readonly schema: string;
	readonly email: EmailConfig;
}

//a token whose message never arrived must be spent after the transaction has committed (E-630)
export async function sendOrUndo(
	mailer: ArtefactMailer,
	minted: MintedArtefact | null,
	message: EmailMessage,
): Promise<void> {
	try {
		await mailer.email.send(message);
	} catch (failure) {
		if (minted !== null) {
			await createOneTimeTokens(
				createOneTimeTokenRepository({ driver: mailer.driver, schema: mailer.schema }),
			)
				.redeem({ token: minted.token, purpose: minted.purpose })
				.catch(() => null);
		}
		throw failure;
	}
}

//the removal is the whole check and an empty result the only sign of invalidity (S-REPLAY-2)
export async function redeemOrRefuse(
	transaction: Driver,
	schema: string,
	attempt: { readonly token: string; readonly purpose: OneTimeTokenPurpose },
): Promise<OneTimeTokenRedemption> {
	const redeemed = await createOneTimeTokens(
		createOneTimeTokenRepository({ driver: transaction, schema }),
	).redeem({ token: toSecretToken(attempt.token), purpose: attempt.purpose });
	if (redeemed === null) {
		throw new ConcealedError("token_not_found");
	}
	return redeemed;
}
