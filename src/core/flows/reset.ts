import type { EmailConfig } from "../auth/config.js";
import type { SignInResult } from "../auth/results.js";
import {
	type Actor,
	actorOfConsumedPendingReset,
	actorOfConsumedRecoveryCode,
	actorOfRedeemedOneTimeToken,
} from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { lockAccountRow } from "../db/lock.js";
import type { IssueAuthorisation } from "../db/repositories/session.js";
import { newPasswordBindingOf } from "../factor/pending/binding.js";
import {
	BROKEN_STATE_ON_FACTOR,
	MISSED_COMPLETION_OF_FACTOR,
	SECOND_FACTOR_PATH,
} from "../factor/pending/complete.js";
import type { SecondFactor } from "../factor/pending/repository.js";
import { createPendingAuthenticationService } from "../factor/pending/service.js";
import { hashPendingToken, type PendingToken } from "../factor/pending/token.js";
import { pepperRecoveryCode, pepperRecoveryCodeUnder } from "../factor/recovery/pepper.js";
import { createRecoveryCodeRepository } from "../factor/recovery/repository.js";
import type { AuthenticationFactor } from "../http/caller.js";
import { ConcealedError, type ConcealedReason } from "../http/error-map.js";
import type { RequestContext } from "../http/route.js";
import { comparisonFormOf } from "../identity/fold.js";
import { normaliseEmail } from "../identity/normalise.js";
import { findUserByIdentifier } from "../identity/resolution.js";
import { equalsInConstantTime } from "../keys/constant-time.js";
import { decryptBound } from "../keys/envelope-binding.js";
import { KeyError } from "../keys/errors.js";
import { CREATED_SCHEME } from "../password/scheme.js";
import { hooksOnTheTransaction } from "../plugin/registry.js";
import { announceEachRevocation } from "../plugin/revocation.js";
import { tellAfterSessionCreate } from "../plugin/sign-in.js";
import { recoveryIsDisabledFor, type SecurityStateRead } from "../security-state/read.js";
import {
	type ChangedAccount,
	recordSealLater,
	reportEnvelopeRefusal,
	sealChange,
	secondFactorsOf,
} from "../security-state/runtime.js";
import {
	componentsAfter,
	type GenerationMoves,
	SealingRefusedError,
	type SealWritten,
} from "../security-state/sealing.js";
import { sessionRowsOn } from "../session/rows.js";
import type { SessionIssuePath } from "../session/service.js";
import { randomUuid } from "../token/random.js";
import {
	mintArtefact,
	movesOfSpentToken,
	ownerAMailedLinkMayReach,
	redeemOrRefuse,
	refuseATokenWrittenBack,
	refuseUnlessTheAddressIsStillTheAccounts,
	sendOrUndo,
	subjectOfAddress,
} from "./artefact.js";
import { type DerivedPassword, derivePassword, writePassword } from "./credential.js";
import {
	type FlowEnvironment,
	mailerOf,
	observedIn,
	refuseADisabledAccount,
	refuseALinkWhileRecoveryIsDisabled,
} from "./environment.js";
import type { RedeemResetResult, SetPasswordResult } from "./results.js";

//an unknown identifier must run the statements a resolved account runs (S-TIM-6)
const AN_ACCOUNT_THAT_CANNOT_EXIST = "00000000-0000-0000-0000-000000000000";

export async function requestReset(
	environment: FlowEnvironment,
	email: EmailConfig,
	context: RequestContext,
	input: { readonly email: string },
): Promise<void> {
	const normalised = normaliseEmail(input.email);
	const address = normalised.accepted ? normalised.value : "";
	await context.enforceAccountRateLimit(address);

	const owner = ownerAMailedLinkMayReach(await environment.services.users.findUserByEmail(address));
	const { driver } = environment.services;
	//the unknown branch must mint a row too and call send exactly once (E-597)
	const minted = await driver.transaction((transaction) =>
		mintArtefact(transaction, environment.services, {
			purpose: "password_reset",
			subject: subjectOfAddress(owner, address),
			accountEmail: owner?.email ?? address,
		}),
	);
	await sendOrUndo(
		mailerOf(environment, email),
		minted,
		owner === null
			? { kind: "request_for_unknown_address", to: input.email, requested: "password_reset" }
			: {
					kind: "password_reset",
					to: address,
					userId: owner.id,
					token: minted.token,
					expiresAt: minted.expiresAt,
				},
	);
}

/** what the path proves under the account lock before the password is replaced */
interface ClaimedUnderLock {
	readonly actor: Actor;
	/** the recovery code the reset spent, which leaves the sealed set */
	readonly spentCode: Uint8Array<ArrayBuffer> | null;
	readonly disabled: boolean;
}

const SPENT_ON_A_DISABLED_ACCOUNT = Symbol("a reset spent on a disabled account");

/** a mailed reset whose account has a second factor, which spent its token and wrote nothing else */
class HeldBackForASecondFactor {
	readonly factors: readonly SecondFactor[];
	/** the epoch the redemption's seal kept, which the pending row binds */
	readonly sessionEpoch: number;

	constructor(factors: readonly SecondFactor[], sessionEpoch: number) {
		this.factors = factors;
		this.sessionEpoch = sessionEpoch;
	}
}

/** the session a replacement issues, and what a missed issue answers as */
interface ReplacementIssue {
	readonly completes: SessionIssuePath;
	readonly factors: readonly AuthenticationFactor[];
}

const ISSUE_OF_A_RESET: ReplacementIssue = { completes: "password_reset", factors: ["password"] };

function withoutTheSpentCode(read: SecurityStateRead, spent: Uint8Array<ArrayBuffer> | null) {
	if (spent === null) {
		return read.recoveryCodes;
	}
	let removed = false;
	return read.recoveryCodes.filter((code) => {
		if (!removed && equalsInConstantTime(code.codeHmac, spent)) {
			removed = true;
			return false;
		}
		return true;
	});
}

/** what a password replacement left, and the seal its caller records once the transaction commits */
interface ReplacedPassword {
	readonly result:
		| SetPasswordResult
		| typeof SPENT_ON_A_DISABLED_ACCOUNT
		| HeldBackForASecondFactor;
	readonly toRecord: SealWritten<unknown>;
}

const NO_FACTOR_HOLDS_IT_BACK: readonly SecondFactor[] = [];

//revocation, new session and credential are one sealing transaction and the revocation comes first (E-610)
async function replacePassword(
	environment: FlowEnvironment,
	context: RequestContext,
	input: {
		readonly transaction: Driver;
		readonly userId: string;
		/** the proof of ownership a conversion of an unsealed account runs under, where the path holds one before the lock */
		readonly account: ChangedAccount;
		readonly derived: DerivedPassword;
		readonly refusal: ConcealedReason;
		readonly occasion: "token_redemption" | "change" | "factor_check";
		readonly claim: (tx: Driver, read: SecurityStateRead) => Promise<ClaimedUnderLock>;
		/** the generation the spent artefact moves, where the replacement redeems a link */
		readonly moves?: GenerationMoves;
		/** the second factors that hold the replacement back, read under the lock, where the path asks for one */
		readonly heldBackBy?: (read: SecurityStateRead) => readonly SecondFactor[];
		readonly issue: ReplacementIssue;
	},
): Promise<ReplacedPassword> {
	const { schema, keys, sessions, pluginRuntime, securityState } = environment.services;
	const sessionId = randomUuid();
	const outcome: { result?: SetPasswordResult } = {};
	//a disabled account is refused and never held back for a factor
	const heldBackBy = (read: SecurityStateRead) =>
		read.disabled ? NO_FACTOR_HOLDS_IT_BACK : (input.heldBackBy?.(read) ?? NO_FACTOR_HOLDS_IT_BACK);
	const sealed = await sealChange(
		securityState,
		input.account,
		{
			//a reset held back for a second factor revokes nothing and keeps the epoch (S-FIX-7)
			epoch: (read) => (heldBackBy(read).length > 0 ? "keep" : "raise"),
			moves: () => input.moves ?? {},
			write: async (tx, read) => {
				const claimed = await input.claim(tx, read);
				const heldBackFor = heldBackBy(read);
				if (claimed.disabled || heldBackFor.length > 0) {
					return { claimed, stored: null, revoked: 0, heldBackFor };
				}
				//a refused session refuses the reset before any revocation is announced (E-2796)
				await hooksOnTheTransaction(pluginRuntime.hooks, tx).beforeSessionCreate({
					userId: input.userId,
					factors: input.issue.factors,
				});
				const sessionRows = sessionRowsOn(sessions, tx);
				//a refusal of the reset rolls its redemption back as well (E-2580)
				if (pluginRuntime.listensTo("beforeSessionRevoke")) {
					await announceEachRevocation(
						pluginRuntime,
						{
							userId: input.userId,
							sessionIds: await sessionRows.listEverySessionIdOwnedBy({ actor: claimed.actor }),
							reason: "password_reset",
						},
						tx,
					);
				}
				const revoked = await sessionRows.deleteEverySessionOwnedBy({ actor: claimed.actor });
				//the storing session must be written with the password in one statement (E-626)
				const stored = await writePassword(
					{ driver: tx, keys, schema, password: environment.services.password },
					{ actor: claimed.actor, derived: input.derived, setBySessionId: sessionId },
				);
				return { claimed, stored, revoked, heldBackFor };
			},
			after: (read, written) =>
				componentsAfter(read, {
					recoveryCodes: withoutTheSpentCode(read, written.claimed.spentCode),
					...(written.stored === null
						? {}
						: {
								password: {
									phc: written.stored.ciphertext,
									keyVersion: written.stored.keyVersion,
									scheme: CREATED_SCHEME,
									setBySessionId: sessionId,
								},
							}),
				}),
			afterSeal: async (tx, next, written) => {
				if (written.stored === null) {
					return;
				}
				const issued = await sessions.boundTo(tx).issueReplacingPresented({
					completes: input.issue.completes,
					authorisedBy: next,
					presentedToken: context.sessionToken,
					userId: input.userId,
					factors: input.issue.factors,
					observed: observedIn(context),
					sessionId,
				});
				outcome.result = {
					sessionToken: issued.token,
					session: issued.session,
					revokedOtherSessionsCount: written.revoked,
				};
			},
		},
		{ driver: input.transaction, refusal: input.refusal, occasion: input.occasion },
	);
	if (sealed.written.claimed.disabled) {
		return { result: SPENT_ON_A_DISABLED_ACCOUNT, toRecord: sealed };
	}
	if (sealed.written.heldBackFor.length > 0) {
		return {
			result: new HeldBackForASecondFactor(sealed.written.heldBackFor, sealed.sessionEpoch),
			toRecord: sealed,
		};
	}
	if (outcome.result === undefined) {
		throw new ConcealedError(input.refusal);
	}
	return { result: outcome.result, toRecord: sealed };
}

//a seal written in the redemption's transaction reaches the anchor only once that transaction committed (S-INTEG-6)
function recordedAfterCommit(
	environment: FlowEnvironment,
	replaced: ReplacedPassword,
	occasion: "token_redemption" | "change" | "factor_check",
): ReplacedPassword["result"] {
	recordSealLater(environment.services.securityState, replaced.toRecord, occasion);
	return replaced.result;
}

export async function redeemReset(
	environment: FlowEnvironment,
	context: RequestContext,
	input: { readonly token: string; readonly newPassword: string },
): Promise<RedeemResetResult> {
	//the policy, validate and the kdf need only the input and run before the token is spent (S-DOS-2)
	const derived = await derivePassword(
		input.newPassword,
		environment.services.password,
		environment.semaphore,
	);
	const { driver } = environment.services;

	const replaced = await driver.transaction(async (transaction) => {
		const redeemed = await redeemOrRefuse(transaction, environment.services, {
			token: input.token,
			purpose: "password_reset",
		});
		return replacePassword(environment, context, {
			transaction,
			userId: redeemed.userId,
			account: actorOfRedeemedOneTimeToken(redeemed),
			derived,
			refusal: "broken_state_on_token_redemption",
			occasion: "token_redemption",
			moves: movesOfSpentToken(redeemed.spent),
			//recovery codes count as a second factor here as they do at sign-in (E-3633)
			heldBackBy: secondFactorsOf,
			issue: ISSUE_OF_A_RESET,
			claim: async (_tx, read) => {
				refuseUnlessTheAddressIsStillTheAccounts(environment.services, redeemed, read.email);
				refuseATokenWrittenBack(environment.services, redeemed.userId, redeemed.spent, read);
				refuseALinkWhileRecoveryIsDisabled(read);
				//a token presented for a disabled account stays spent once it is enabled again (E-2879)
				return {
					actor: actorOfRedeemedOneTimeToken(redeemed),
					spentCode: null,
					disabled: read.disabled,
				};
			},
		});
	});
	const result = recordedAfterCommit(environment, replaced, "token_redemption");
	if (result === SPENT_ON_A_DISABLED_ACCOUNT) {
		refuseADisabledAccount();
	}
	if (result instanceof HeldBackForASecondFactor) {
		return holdBackForASecondFactor(environment, context, {
			userId: replaced.toRecord.userId,
			heldBack: result,
			derived,
		});
	}

	await tellAfterSessionCreate(environment.services.pluginRuntime.hooks, result.session);
	context.cookies.setSession(result.sessionToken);
	return { status: "password_reset", ...result };
}

//the pending row binds the seal the redemption wrote and holds the new password only sealed (S-FIX-7)
async function holdBackForASecondFactor(
	environment: FlowEnvironment,
	context: RequestContext,
	input: {
		readonly userId: string;
		readonly heldBack: HeldBackForASecondFactor;
		readonly derived: DerivedPassword;
	},
): Promise<RedeemResetResult> {
	const begun = await environment.services.pending.begin({
		userId: input.userId,
		factorsCompleted: [],
		sessionEpoch: input.heldBack.sessionEpoch,
		offered: { factors: input.heldBack.factors, refusal: "broken_state_on_token_redemption" },
		newPassword: input.derived,
	});
	context.cookies.setPending(begun.token);
	return { status: "second_factor_required", pendingToken: begun.token, pending: begun.pending };
}

//the envelope opens only under the owner and token hash of the row it was sealed into (S-INTEG-1)
async function openHeldBackPassword(
	environment: FlowEnvironment,
	input: {
		readonly userId: string;
		readonly pendingToken: PendingToken;
		readonly stored: { readonly ciphertext: Uint8Array; readonly keyVersion: number };
		readonly factor: SecondFactor;
	},
): Promise<DerivedPassword> {
	try {
		const phc = await decryptBound(
			environment.services.keys,
			newPasswordBindingOf(input.userId, hashPendingToken(input.pendingToken)),
			{ keyVersion: input.stored.keyVersion, ciphertext: new Uint8Array(input.stored.ciphertext) },
			"refused",
		);
		return { phc: new TextDecoder().decode(phc) };
	} catch (failure) {
		reportEnvelopeRefusal(
			environment.services.securityState,
			input.userId,
			"factor_check",
			failure,
		);
		throw failure instanceof KeyError
			? new ConcealedError(BROKEN_STATE_ON_FACTOR[input.factor])
			: failure;
	}
}

function isTheStateTheFactorChecked(
	read: SecurityStateRead,
	authorisedBy: IssueAuthorisation,
): boolean {
	if (authorisedBy === "unsealed") {
		return read.seal === null;
	}
	return (
		read.seal !== null &&
		read.seal.componentsVersion === authorisedBy.componentsVersion &&
		read.seal.sessionEpoch === authorisedBy.sessionEpoch
	);
}

/** the second factor a held back reset was completed with, as its check left it */
interface CheckedFactorOfAReset {
	readonly pendingToken: PendingToken;
	readonly factor: SecondFactor;
	/** the seal the factor check read or left, which the completion must still find under the lock */
	readonly authorisedBy: IssueAuthorisation;
	readonly signCountRegressed?: boolean;
}

//the row is removed and the password written, every session revoked and one issued in one transaction (S-FIX-8)
export async function completeResetBySecondFactor(
	environment: FlowEnvironment,
	context: RequestContext,
	checked: CheckedFactorOfAReset,
): Promise<SignInResult> {
	const { driver, keys, schema, reportTokenBindingRefusal } = environment.services;
	const factors: readonly AuthenticationFactor[] = ["password", checked.factor];
	const replaced = await driver.transaction(async (transaction) => {
		const consumed = await createPendingAuthenticationService({
			driver: transaction,
			keys,
			schema,
			reportTokenBindingRefusal,
		}).consume(checked.pendingToken);
		if (consumed.reset === null) {
			throw new ConcealedError("pending_consumed");
		}
		const { reset } = consumed;
		const actor = actorOfConsumedPendingReset(reset.consumed);
		return replacePassword(environment, context, {
			transaction,
			userId: consumed.userId,
			account: actor,
			derived: await openHeldBackPassword(environment, {
				userId: consumed.userId,
				pendingToken: checked.pendingToken,
				stored: reset.newPassword,
				factor: checked.factor,
			}),
			refusal: BROKEN_STATE_ON_FACTOR[checked.factor],
			occasion: "factor_check",
			issue: { completes: SECOND_FACTOR_PATH[checked.factor], factors },
			//a change of the account since the factor check answers as the factor fails (S-INTEG-5)
			claim: async (_tx, read) => {
				if (!isTheStateTheFactorChecked(read, checked.authorisedBy)) {
					throw new ConcealedError(MISSED_COMPLETION_OF_FACTOR[checked.factor]);
				}
				//a reset held back before recovery was turned off never writes its password (S-ENUM-9)
				if (recoveryIsDisabledFor(read)) {
					throw new ConcealedError("recovery_disabled_on_pending_reset");
				}
				return { actor, spentCode: null, disabled: read.disabled };
			},
		});
	});
	const result = recordedAfterCommit(environment, replaced, "factor_check");
	//a disabled account answers as a pending state that is no longer there
	if (result === SPENT_ON_A_DISABLED_ACCOUNT || result instanceof HeldBackForASecondFactor) {
		throw new ConcealedError("pending_not_found");
	}

	await tellAfterSessionCreate(environment.services.pluginRuntime.hooks, result.session);
	const user = await environment.services.users.findUserById(result.session.userId);
	if (user === null) {
		throw new ConcealedError("pending_not_found");
	}
	context.cookies.clearPending();
	context.cookies.setSession(result.sessionToken);
	return {
		status: "signed_in",
		sessionToken: result.sessionToken,
		session: result.session,
		user,
		...(checked.signCountRegressed === undefined
			? {}
			: { signCountRegressed: checked.signCountRegressed }),
	};
}

//a consumed recovery code must not be replaced by a newly generated one
export async function redeemResetWithRecoveryCode(
	environment: FlowEnvironment,
	context: RequestContext,
	input: {
		readonly identifier: string;
		readonly recoveryCode: string;
		readonly newPassword: string;
	},
): Promise<SetPasswordResult> {
	//an attempt the account bucket refuses must derive nothing (S-RATE-7)
	await context.enforceAccountRateLimit(comparisonFormOf(input.identifier));
	const derived = await derivePassword(
		input.newPassword,
		environment.services.password,
		environment.semaphore,
	);
	const { driver, schema, identity, keys } = environment.services;

	const found = await findUserByIdentifier({
		driver,
		schema,
		configuration: identity,
		identifier: input.identifier,
	});
	const userId = found === null ? AN_ACCOUNT_THAT_CANNOT_EXIST : found.id;

	const codes = createRecoveryCodeRepository({ driver, schema });
	const versions = await codes.pepperVersionsOf({ userId });
	//an account with no codes must still cost one hmac (S-TIM-6)
	const candidates =
		versions.length === 0
			? [(await pepperRecoveryCode(keys, input.recoveryCode)).codeHmac]
			: (
					await Promise.all(
						versions.map((version) => pepperRecoveryCodeUnder(keys, version, input.recoveryCode)),
					)
				)
					.filter((peppered) => peppered !== null)
					.map((peppered) => peppered.codeHmac);

	if (found === null) {
		//an unknown account still locks and consumes as a known one does (S-TIM-6)
		await driver.transaction(async (transaction) => {
			await lockAccountRow(transaction, schema, userId);
			await createRecoveryCodeRepository({ driver: transaction, schema }).consumeCode({
				userId,
				candidateHmacs: candidates,
			});
		});
		throw new ConcealedError("recovery_code_not_found");
	}
	const replaced = await driver.transaction((transaction) =>
		replacePassword(environment, context, {
			transaction,
			userId: found.id,
			//the code that proves the account is the caller's is consumed under the lock after any conversion (E-3162)
			account: { unproven: found.id },
			derived,
			refusal: "recovery_code_not_found",
			occasion: "change",
			issue: ISSUE_OF_A_RESET,
			//the code is consumed under the account lock and must be one of the codes the seal covers (E-1601)
			claim: async (tx, read) => {
				//a code presented while recovery is off answers as a wrong code (S-ENUM-9)
				if (recoveryIsDisabledFor(read)) {
					throw new ConcealedError("recovery_code_not_found");
				}
				const consumed = await createRecoveryCodeRepository({ driver: tx, schema }).consumeCode({
					userId: found.id,
					candidateHmacs: candidates,
				});
				if (consumed === null) {
					throw new ConcealedError("recovery_code_not_found");
				}
				if (
					!read.recoveryCodes.some((code) => equalsInConstantTime(code.codeHmac, consumed.codeHmac))
				) {
					throw new SealingRefusedError("seal_mismatch");
				}
				//a code presented for a disabled account stays spent once it is enabled again (E-2872)
				return {
					actor: actorOfConsumedRecoveryCode(consumed.consumed),
					spentCode: consumed.codeHmac,
					disabled: read.disabled,
				};
			},
		}),
	);
	const result = recordedAfterCommit(environment, replaced, "change");
	//a disabled account must answer as a wrong code does
	if (result === SPENT_ON_A_DISABLED_ACCOUNT || result instanceof HeldBackForASecondFactor) {
		throw new ConcealedError("recovery_code_not_found");
	}

	await tellAfterSessionCreate(environment.services.pluginRuntime.hooks, result.session);
	context.cookies.setSession(result.sessionToken);
	return result;
}
