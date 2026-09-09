import type { EmailConfig, EmailMessage } from "../auth/config.js";
import type { Driver } from "../db/driver.js";
import { createOneTimeTokenRepository } from "../db/repositories/token.js";
import { ConcealedError } from "../http/error-map.js";
import { createOneTimeTokens, type OneTimeTokenRedemption } from "../token/one-time-token.js";
import type { OneTimeTokenPayload, OneTimeTokenPurpose } from "../token/purpose.js";
import type { SecretToken } from "../token/secret-token.js";

interface MailedArtefact {
	readonly purpose: OneTimeTokenPurpose;
	/** `null` when the address named no account: the artefact is minted all the same (S-TIM-6, E-597). */
	readonly userId: string | null;
	readonly payload?: OneTimeTokenPayload;
	readonly message: (issued: { readonly token: string; readonly expiresAt: Date }) => EmailMessage;
}

export interface ArtefactMailer {
	readonly driver: Driver;
	readonly schema: string;
	readonly email: EmailConfig;
}

/**
 * A.7, last paragraph: a `send` that throws fails the operation and rolls the token back, because
 * a reset token whose message never arrived is of use to nobody but an attacker. The callback
 * therefore runs inside the transaction that wrote the row — and inside the row lock on
 * `velve.user` that writing it takes, which is why `send` must enqueue rather than deliver (E-600).
 */
export async function mintAndMail(mailer: ArtefactMailer, artefact: MailedArtefact): Promise<void> {
	await mailer.driver.transaction(async (transaction) => {
		const tokens = createOneTimeTokens(
			createOneTimeTokenRepository({ driver: transaction, schema: mailer.schema }),
		);
		const issued = await tokens.issue({
			purpose: artefact.purpose,
			userId: artefact.userId,
			...(artefact.payload === undefined ? {} : { payload: artefact.payload }),
		});
		await mailer.email.send(artefact.message({ token: issued.token, expiresAt: issued.expiresAt }));
	});
}

/**
 * S-REPLAY-2 and S-RACE-1: the removal is the whole check, and an empty result is the only signal
 * of invalidity — expired, spent and never issued are one answer (S-REPLAY-3, S-TOKEN-2).
 */
export async function redeemOrRefuse(
	transaction: Driver,
	schema: string,
	attempt: { readonly token: SecretToken; readonly purpose: OneTimeTokenPurpose },
): Promise<OneTimeTokenRedemption> {
	const redeemed = await createOneTimeTokens(
		createOneTimeTokenRepository({ driver: transaction, schema }),
	).redeem(attempt);
	if (redeemed === null) {
		throw new ConcealedError("token_not_found");
	}
	return redeemed;
}
