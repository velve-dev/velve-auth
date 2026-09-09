import type { EmailConfig, EmailMessage } from "../auth/config.js";
import type { Driver } from "../db/driver.js";
import { createOneTimeTokenRepository } from "../db/repositories/token.js";
import { ConcealedError } from "../http/error-map.js";
import {
	createOneTimeTokens,
	type IssuedOneTimeToken,
	type OneTimeTokenRedemption,
} from "../token/one-time-token.js";
import type { OneTimeTokenPayload, OneTimeTokenPurpose } from "../token/purpose.js";
import { toSecretToken } from "../token/secret-token.js";

export interface MintedArtefact extends IssuedOneTimeToken {
	readonly purpose: OneTimeTokenPurpose;
}

/**
 * Writes the row inside the caller's transaction. An address that names no account mints one too:
 * the row names no owner, S-TOKEN-4 answers it exactly as it answers no row, and the two branches
 * therefore cost the same statements (S-TIM-6, E-597).
 */
export async function mintArtefact(
	transaction: Driver,
	schema: string,
	request: {
		readonly purpose: OneTimeTokenPurpose;
		readonly userId: string | null;
		readonly payload?: OneTimeTokenPayload;
	},
): Promise<MintedArtefact> {
	const issued = await createOneTimeTokens(
		createOneTimeTokenRepository({ driver: transaction, schema }),
	).issue({
		purpose: request.purpose,
		userId: request.userId,
		...(request.payload === undefined ? {} : { payload: request.payload }),
	});
	return { ...issued, purpose: request.purpose };
}

export interface ArtefactMailer {
	readonly driver: Driver;
	readonly schema: string;
	readonly email: EmailConfig;
}

/**
 * A.7: a `send` that throws fails the operation and takes the artefact with it, because a reset
 * token whose message never arrived is of use to nobody but an attacker. The callback runs **after**
 * the transaction has committed and the row lock on `velve.user` has gone, and a throw is answered
 * by spending the token through the one statement that spends tokens — a compensation rather than a
 * rollback, which is the trade E-630 records.
 */
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

/**
 * S-REPLAY-2 and S-RACE-1: the removal is the whole check, and an empty result is the only signal
 * of invalidity — expired, spent and never issued are one answer (S-REPLAY-3, S-TOKEN-2).
 */
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
