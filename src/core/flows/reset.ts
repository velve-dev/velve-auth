import type { EmailConfig } from "../auth/config.js";
import {
	type Actor,
	actorOfConsumedRecoveryCode,
	actorOfRedeemedOneTimeToken,
} from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { lockAccountRow } from "../db/lock.js";
import { pepperRecoveryCode, pepperRecoveryCodeUnder } from "../factor/recovery/pepper.js";
import { createRecoveryCodeRepository } from "../factor/recovery/repository.js";
import { ConcealedError, type ConcealedReason } from "../http/error-map.js";
import type { RequestContext } from "../http/route.js";
import { comparisonFormOf } from "../identity/fold.js";
import { normaliseEmail } from "../identity/normalise.js";
import { findUserByIdentifier } from "../identity/resolution.js";
import { equalsInConstantTime } from "../keys/constant-time.js";
import { CREATED_SCHEME } from "../password/scheme.js";
import { hooksOnTheTransaction } from "../plugin/registry.js";
import { announceEachRevocation } from "../plugin/revocation.js";
import { tellAfterSessionCreate } from "../plugin/sign-in.js";
import type { SecurityStateRead } from "../security-state/read.js";
import { type ChangedAccount, recordSealLater, sealChange } from "../security-state/runtime.js";
import {
	componentsAfter,
	SealingRefusedError,
	type SealWritten,
} from "../security-state/sealing.js";
import { sessionRowsOn } from "../session/rows.js";
import { randomUuid } from "../token/random.js";
import {
	mintArtefact,
	redeemOrRefuse,
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
} from "./environment.js";
import type { SetPasswordResult } from "./results.js";

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

	const owner = await environment.services.users.findUserByEmail(address);
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
	readonly result: SetPasswordResult | typeof SPENT_ON_A_DISABLED_ACCOUNT;
	readonly toRecord: SealWritten<unknown>;
}

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
		readonly occasion: "token_redemption" | "change";
		readonly claim: (tx: Driver, read: SecurityStateRead) => Promise<ClaimedUnderLock>;
	},
): Promise<ReplacedPassword> {
	const { schema, keys, sessions, pluginRuntime, securityState } = environment.services;
	const sessionId = randomUuid();
	const outcome: { result?: SetPasswordResult } = {};
	const sealed = await sealChange(
		securityState,
		input.account,
		{
			epoch: "raise",
			write: async (tx, read) => {
				const claimed = await input.claim(tx, read);
				if (claimed.disabled) {
					return { claimed, stored: null, revoked: 0 };
				}
				//a refused session refuses the reset before any revocation is announced (E-2796)
				await hooksOnTheTransaction(pluginRuntime.hooks, tx).beforeSessionCreate({
					userId: input.userId,
					factors: ["password"],
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
				return { claimed, stored, revoked };
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
					completes: "password_reset",
					authorisedBy: next,
					presentedToken: context.sessionToken,
					userId: input.userId,
					factors: ["password"],
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
	if (outcome.result === undefined) {
		throw new ConcealedError(input.refusal);
	}
	return { result: outcome.result, toRecord: sealed };
}

//a seal written in the redemption's transaction reaches the anchor only once that transaction committed (S-INTEG-6)
function recordedAfterCommit(
	environment: FlowEnvironment,
	replaced: ReplacedPassword,
	occasion: "token_redemption" | "change",
): SetPasswordResult | typeof SPENT_ON_A_DISABLED_ACCOUNT {
	recordSealLater(environment.services.securityState, replaced.toRecord, occasion);
	return replaced.result;
}

export async function redeemReset(
	environment: FlowEnvironment,
	context: RequestContext,
	input: { readonly token: string; readonly newPassword: string },
): Promise<SetPasswordResult> {
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
			claim: async (_tx, read) => {
				refuseUnlessTheAddressIsStillTheAccounts(environment.services, redeemed, read.email);
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

	await tellAfterSessionCreate(environment.services.pluginRuntime.hooks, result.session);
	context.cookies.setSession(result.sessionToken);
	return result;
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
			//the code is consumed under the account lock and must be one of the codes the seal covers (E-1601)
			claim: async (tx, read) => {
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
	if (result === SPENT_ON_A_DISABLED_ACCOUNT) {
		throw new ConcealedError("recovery_code_not_found");
	}

	await tellAfterSessionCreate(environment.services.pluginRuntime.hooks, result.session);
	context.cookies.setSession(result.sessionToken);
	return result;
}
