import type { EmailConfig } from "../auth/config.js";
import { createOneTimeTokenRepository } from "../db/repositories/token.js";
import { ConcealedError, VelveError } from "../http/error-map.js";
import type { RequestContext } from "../http/route.js";
import { normaliseEmail } from "../identity/normalise.js";
import { recordSealLater } from "../security-state/runtime.js";
import { ONE_TIME_TOKEN_PURPOSES } from "../token/purpose.js";
import { mintArtefact, redeemOrRefuse, sendOrUndo } from "./artefact.js";
import { confirmAddress } from "./confirmation.js";
import {
	accountOrDisabledOfRedemption,
	DisabledRedemption,
	type FlowEnvironment,
	mailerOf,
	readAccountOfSession,
	readUserOrRefuse,
	refuseADisabledAccount,
	sessionOfCaller,
} from "./environment.js";
import type { ChangedUser } from "./results.js";

//the address in a change token is normalised when minted and not when redeemed
const CHANGED_ADDRESS = "email";

function addressIn(payload: Readonly<Record<string, unknown>> | null): string {
	const address = payload?.[CHANGED_ADDRESS];
	if (typeof address !== "string") {
		throw new ConcealedError("token_not_found");
	}
	return address;
}

//an address parameter here would be an enumeration interface behind a session
export async function requestVerification(
	environment: FlowEnvironment,
	email: EmailConfig,
	context: RequestContext,
	userId: string,
): Promise<void> {
	const user = await readAccountOfSession(environment, userId);
	const address = user.email;
	if (address === null) {
		throw new VelveError("invalid_input");
	}
	await context.enforceAccountRateLimit(address);
	const { driver } = environment.services;
	const minted = await driver.transaction((transaction) =>
		mintArtefact(transaction, environment.services, {
			purpose: "email_verify",
			subject: { userId: user.id },
			accountEmail: address,
		}),
	);
	await sendOrUndo(mailerOf(environment, email), minted, {
		kind: "email_verification",
		to: address,
		userId: user.id,
		token: minted.token,
		expiresAt: minted.expiresAt,
	});
}

export async function redeemVerification(
	environment: FlowEnvironment,
	context: RequestContext,
	input: { readonly token: string },
): Promise<ChangedUser> {
	const { driver, schema } = environment.services;
	const confirmingSession = await sessionOfCaller(environment, context);

	const redemption = await driver.transaction(async (transaction) => {
		const redeemed = await redeemOrRefuse(transaction, environment.services, {
			token: input.token,
			purpose: "email_verify",
		});
		const account = await accountOrDisabledOfRedemption(environment, transaction, redeemed);
		//a token presented for a disabled account stays spent once it is enabled again (E-2880)
		if (account instanceof DisabledRedemption) {
			return account;
		}
		//the confirmation link is one of the two ways an address is first confirmed (S-LINK-4)
		const confirmed = await confirmAddress({
			transaction,
			schema,
			pluginRuntime: environment.services.pluginRuntime,
			sessions: environment.services.sessions,
			actor: account.actor,
			confirmingSession,
			newEmail: null,
			securityState: environment.services.securityState,
			spent: redeemed.spent,
		});
		return { userId: account.user.id, toRecord: confirmed.toRecord };
	});
	if (redemption instanceof DisabledRedemption) {
		recordSealLater(environment.services.securityState, redemption.toRecord, "token_redemption");
		refuseADisabledAccount();
	}
	recordSealLater(environment.services.securityState, redemption.toRecord, "token_redemption");
	const userId = redemption.userId;

	return { user: await readUserOrRefuse(environment, driver, userId) };
}

//a taken target address must only be detected when the token is redeemed (E-606)
export async function requestChange(
	environment: FlowEnvironment,
	email: EmailConfig,
	context: RequestContext,
	userId: string,
	input: { readonly newEmail: string },
): Promise<void> {
	const normalised = normaliseEmail(input.newEmail);
	if (!normalised.accepted) {
		throw new VelveError("invalid_input");
	}
	const address = normalised.value;
	await context.enforceAccountRateLimit(address);

	const user = await readAccountOfSession(environment, userId);
	const previousEmail = user.email ?? "";
	const { driver } = environment.services;
	const minted = await driver.transaction((transaction) =>
		mintArtefact(transaction, environment.services, {
			purpose: "email_change",
			subject: { userId: user.id },
			accountEmail: user.email,
			payload: { [CHANGED_ADDRESS]: address },
		}),
	);
	await sendOrUndo(mailerOf(environment, email), minted, {
		kind: "email_change",
		to: address,
		userId: user.id,
		token: minted.token,
		expiresAt: minted.expiresAt,
		previousEmail,
	});
}

export async function redeemChange(
	environment: FlowEnvironment,
	context: RequestContext,
	input: { readonly token: string },
): Promise<ChangedUser> {
	const { driver, schema } = environment.services;
	const confirmingSession = await sessionOfCaller(environment, context);

	const redemption = await driver.transaction(async (transaction) => {
		const redeemed = await redeemOrRefuse(transaction, environment.services, {
			token: input.token,
			purpose: "email_change",
		});
		const account = await accountOrDisabledOfRedemption(environment, transaction, redeemed);
		//a token presented for a disabled account stays spent once it is enabled again (E-2880)
		if (account instanceof DisabledRedemption) {
			return account;
		}
		//the old address's links go before the account lock as one_time_token precedes velve.user (E-3278)
		const tokens = createOneTimeTokenRepository({ driver: transaction, schema });
		for (const purpose of ONE_TIME_TOKEN_PURPOSES) {
			await tokens.withdrawTokensOf({ actor: account.actor, purpose });
		}
		const newEmail = addressIn(redeemed.payload);
		//redeeming proves the new address and a collision must leave both changes undone
		const confirmed = await confirmAddress({
			transaction,
			schema,
			pluginRuntime: environment.services.pluginRuntime,
			sessions: environment.services.sessions,
			actor: account.actor,
			confirmingSession,
			newEmail,
			securityState: environment.services.securityState,
			spent: redeemed.spent,
		});
		const change: CommittedChange = {
			userId: account.user.id,
			//the previous address is the one the confirmation read under the account lock (E-3712)
			previousEmail: confirmed.toRecord.read.email,
			newEmail,
		};
		return { change, toRecord: confirmed.toRecord };
	});
	if (redemption instanceof DisabledRedemption) {
		recordSealLater(environment.services.securityState, redemption.toRecord, "token_redemption");
		refuseADisabledAccount();
	}
	recordSealLater(environment.services.securityState, redemption.toRecord, "token_redemption");
	await tellOfTheCommittedChange(environment, redemption.change);

	return { user: await readUserOrRefuse(environment, driver, redemption.change.userId) };
}

interface CommittedChange {
	readonly userId: string;
	readonly previousEmail: string | null;
	readonly newEmail: string;
}

//a refusing plugin must not keep the previous address from being told (E-3714)
async function tellOfTheCommittedChange(
	environment: FlowEnvironment,
	change: CommittedChange,
): Promise<void> {
	if (change.previousEmail === change.newEmail) {
		return;
	}
	const unsent = await noticeThePreviousAddress(environment, change).then(
		() => null,
		(failure: unknown) => ({ failure }),
	);
	try {
		await environment.services.pluginRuntime.hooks.afterEmailChange({ userId: change.userId });
	} catch (refusal) {
		//a refusing hook must not hide that the notice was not sent (E-3717)
		throw unsent === null ? refusal : bothFailures(unsent.failure, refusal);
	}
	//a notice that could not be sent fails the answer and leaves the committed change standing (E-3713)
	if (unsent !== null) {
		throw unsent.failure;
	}
}

function messageOf(failure: unknown): string {
	return failure instanceof Error ? failure.message : String(failure);
}

function bothFailures(unsent: unknown, refusal: unknown): AggregateError {
	return new AggregateError(
		[unsent, refusal],
		`the address change notice was not sent: ${messageOf(unsent)}; afterEmailChange failed: ${messageOf(refusal)}`,
	);
}

//whoever holds the old mailbox learns neither the new address nor a link (E-3711)
async function noticeThePreviousAddress(
	environment: FlowEnvironment,
	change: CommittedChange,
): Promise<void> {
	const email = environment.services.email;
	if (email === undefined || change.previousEmail === null) {
		return;
	}
	await sendOrUndo(mailerOf(environment, email), null, {
		kind: "email_change_notice",
		to: change.previousEmail,
		userId: change.userId,
	});
}
