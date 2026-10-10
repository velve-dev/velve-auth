import type { EmailConfig, EmailMessage } from "../auth/config.js";
import type { Driver } from "../db/driver.js";
import { createOneTimeTokenRepository } from "../db/repositories/token.js";
import { ConcealedError } from "../http/error-map.js";
import { equalsInConstantTime } from "../keys/constant-time.js";
import type { KeyProvider } from "../keys/provider.js";
import { FIRST_GENERATIONS } from "../security-state/encoding.js";
import type { SecurityStateRead } from "../security-state/read.js";
import type { GenerationMoves } from "../security-state/sealing.js";
import {
	reportBrokenState,
	reportRefusedTokenRow,
	type TokenBindingRefusalReport,
} from "../token/binding.js";
import {
	createOneTimeTokens,
	type IssuedOneTimeToken,
	type OneTimeTokenRedemption,
	type SpentToken,
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

/** where one-time tokens are written and the keys their MACs are taken under */
interface ArtefactStore {
	readonly schema: string;
	readonly keys: KeyProvider;
	readonly reportTokenBindingRefusal?: TokenBindingRefusalReport;
}

function oneTimeTokensOn(driver: Driver, store: ArtefactStore) {
	return createOneTimeTokens(
		createOneTimeTokenRepository({ driver, schema: store.schema }),
		store.reportTokenBindingRefusal === undefined
			? { keys: store.keys }
			: { keys: store.keys, reportTokenBindingRefusal: store.reportTokenBindingRefusal },
	);
}

const ACCOUNT_ADDRESS = "accountEmail";

//an address that names no account must mint a row too and cost the same statements (E-597)
export async function mintArtefact(
	transaction: Driver,
	store: ArtefactStore,
	request: {
		readonly purpose: OneTimeTokenPurpose;
		readonly subject: OneTimeTokenSubject;
		/** the account's address the token is issued against, which redemption must still find */
		readonly accountEmail: string | null;
		readonly payload?: OneTimeTokenPayload;
	},
): Promise<MintedArtefact> {
	const issued = await oneTimeTokensOn(transaction, store).issue({
		...request.subject,
		purpose: request.purpose,
		payload: { ...request.payload, [ACCOUNT_ADDRESS]: request.accountEmail },
	});
	return { ...issued, purpose: request.purpose };
}

//a token mailed while a writer had moved the account's address must not be redeemed after it moved back (E-3264)
export function refuseUnlessTheAddressIsStillTheAccounts(
	store: ArtefactStore,
	redeemed: OneTimeTokenRedemption,
	accountEmail: string | null,
): void {
	const bound = redeemed.payload?.[ACCOUNT_ADDRESS];
	if (bound !== undefined && bound === accountEmail) {
		return;
	}
	reportBrokenState(store.reportTokenBindingRefusal, {
		userId: redeemed.userId,
		occasion: "token_redemption",
		reason: "seal_mismatch",
	});
	throw new ConcealedError("token_not_found");
}

//a link written back after its redemption binds a token generation the account has left (E-3522)
export function refuseATokenWrittenBack(
	store: ArtefactStore,
	userId: string,
	spent: SpentToken,
	read: SecurityStateRead,
): void {
	const current = (read.seal ?? FIRST_GENERATIONS).tokenGenerations[spent.purpose];
	if (spent.tokenGeneration === current) {
		return;
	}
	const last = read.seal?.tokenLast ?? null;
	//a link a later redemption overtook is no writer's doing and raises no alarm
	if (
		last !== null &&
		equalsInConstantTime(new Uint8Array(last), new Uint8Array(spent.tokenSha256))
	) {
		reportRefusedTokenRow(store.reportTokenBindingRefusal, {
			userId,
			occasion: "token_redemption",
			verdict: "mismatch",
		});
	}
	throw new ConcealedError("token_not_found");
}

/** the generation a redemption moves, so the row it spent cannot be spent again */
export function movesOfSpentToken(spent: SpentToken): GenerationMoves {
	return { token: { purpose: spent.purpose, last: spent.tokenSha256 } };
}

//a request for an unknown address must wait where a request for an account waits (E-931)
export function subjectOfAddress(
	owner: { readonly id: string } | null,
	address: string,
): OneTimeTokenSubject {
	return owner === null ? { userId: null, serialisedOn: address } : { userId: owner.id };
}

export interface ArtefactMailer extends ArtefactStore {
	readonly driver: Driver;
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
			await oneTimeTokensOn(mailer.driver, mailer)
				.redeem({ token: minted.token, purpose: minted.purpose })
				.catch(() => null);
		}
		throw failure;
	}
}

//the removal is the whole check and an empty result the only sign of invalidity (S-REPLAY-2)
export async function redeemOrRefuse(
	transaction: Driver,
	store: ArtefactStore,
	attempt: { readonly token: string; readonly purpose: OneTimeTokenPurpose },
): Promise<OneTimeTokenRedemption> {
	const redeemed = await oneTimeTokensOn(transaction, store).redeem({
		token: toSecretToken(attempt.token),
		purpose: attempt.purpose,
	});
	if (redeemed === null) {
		throw new ConcealedError("token_not_found");
	}
	return redeemed;
}
