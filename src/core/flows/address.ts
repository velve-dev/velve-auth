import type { EmailConfig } from "../auth/config.js";
import { ConcealedError, VelveError } from "../http/error-map.js";
import type { RequestContext } from "../http/route.js";
import { normaliseEmail } from "../identity/normalise.js";
import { mintArtefact, redeemOrRefuse, sendOrUndo } from "./artefact.js";
import { confirmAddress } from "./confirmation.js";
import {
	accountOfRedemption,
	type FlowEnvironment,
	mailerOf,
	readAccountOfSession,
	readUserOrRefuse,
	sessionIdOfCaller,
} from "./environment.js";
import type { ChangedUser } from "./results.js";

/** The address a change token carries. It is normalised when the token is minted, not when it is redeemed. */
const CHANGED_ADDRESS = "email";

function addressIn(payload: Readonly<Record<string, unknown>> | null): string {
	const address = payload?.[CHANGED_ADDRESS];
	if (typeof address !== "string") {
		throw new ConcealedError("token_not_found");
	}
	return address;
}

/**
 * 3.15 B.5: no address is passed in. The one that gets confirmed is the one on the account, because
 * an address as a parameter would be an enumeration interface with a session in front of it.
 */
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
	const { driver, schema } = environment.services;
	const minted = await driver.transaction((transaction) =>
		mintArtefact(transaction, schema, { purpose: "email_verify", subject: { userId: user.id } }),
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
	const confirmingSessionId = await sessionIdOfCaller(environment, context);

	const userId = await driver.transaction(async (transaction) => {
		const redeemed = await redeemOrRefuse(transaction, schema, {
			token: input.token,
			purpose: "email_verify",
		});
		const account = await accountOfRedemption(environment, transaction, redeemed);
		// S-LINK-4: the confirmation link is the second of the two ways an address is first confirmed.
		await confirmAddress({
			transaction,
			schema,
			actor: account.actor,
			confirmingSessionId,
			newEmail: null,
		});
		return account.user.id;
	});

	return { user: await readUserOrRefuse(environment, driver, userId) };
}

/**
 * S-ENUM-5: a target address that belongs to another account is not looked up here. The request
 * mints and mails exactly as it does for a free address, and the collision is found an hour later
 * where the token is redeemed — which is the only place it can be found without answering the
 * question the caller is asking.
 */
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
	const { driver, schema } = environment.services;
	const minted = await driver.transaction((transaction) =>
		mintArtefact(transaction, schema, {
			purpose: "email_change",
			subject: { userId: user.id },
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
	const confirmingSessionId = await sessionIdOfCaller(environment, context);

	const userId = await driver.transaction(async (transaction) => {
		const redeemed = await redeemOrRefuse(transaction, schema, {
			token: input.token,
			purpose: "email_change",
		});
		const account = await accountOfRedemption(environment, transaction, redeemed);
		// 3.15 B.5: redeeming proves the new address, so it is confirmed in the same statement that
		// moves it — and a collision leaves both undone, which is what T-ENUM-5 counts.
		await confirmAddress({
			transaction,
			schema,
			actor: account.actor,
			confirmingSessionId,
			newEmail: addressIn(redeemed.payload),
		});
		return account.user.id;
	});

	return { user: await readUserOrRefuse(environment, driver, userId) };
}
