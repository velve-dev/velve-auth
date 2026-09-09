import type { EmailConfig } from "../auth/config.js";
import type { SignInResult } from "../auth/results.js";
import type { RequestContext } from "../http/route.js";
import { normaliseEmail } from "../identity/normalise.js";
import { mintArtefact, redeemOrRefuse, sendOrUndo, subjectOfAddress } from "./artefact.js";
import { confirmAddress } from "./confirmation.js";
import {
	accountOfRedemption,
	type FlowEnvironment,
	mailerOf,
	observedIn,
	readUserOrRefuse,
	sessionIdOfCaller,
} from "./environment.js";

/**
 * S-TIM-6 and L-1: the two branches run the same statements and call `send` exactly once. What
 * makes that possible is the cover artefact of E-597 — an address naming no account still mints a
 * row, one that names no owner and that S-TOKEN-4 answers exactly as it answers no row.
 */
export async function requestMagicLink(
	environment: FlowEnvironment,
	email: EmailConfig,
	context: RequestContext,
	input: { readonly email: string },
): Promise<void> {
	const normalised = normaliseEmail(input.email);
	// An address the allowlist rejects is looked up all the same, so a malformed one costs the same
	// round trip as a well-formed one that names nobody (S-ENUM-1's reasoning, E-46).
	const address = normalised.accepted ? normalised.value : "";
	await context.enforceAccountRateLimit(address);

	const owner = await environment.services.users.findUserByEmail(address);
	const { driver, schema } = environment.services;
	const minted = await driver.transaction((transaction) =>
		mintArtefact(transaction, schema, {
			purpose: "magic_link",
			subject: subjectOfAddress(owner, address),
		}),
	);
	await sendOrUndo(
		mailerOf(environment, email),
		minted,
		owner === null
			? { kind: "request_for_unknown_address", to: input.email, requested: "magic_link" }
			: {
					kind: "magic_link",
					to: address,
					userId: owner.id,
					token: minted.token,
					expiresAt: minted.expiresAt,
				},
	);
}

/**
 * S-LINK-4: redeeming a magic link is a confirmation of the address, so a password set in any other
 * session goes and every session with it — the pre-registered account of GHSA-qq9h-g4jm-xgf3 keeps
 * nothing. A magic link links no provider identity; nothing here writes `velve.identity`.
 */
export async function redeemMagicLink(
	environment: FlowEnvironment,
	context: RequestContext,
	input: { readonly token: string },
): Promise<SignInResult> {
	const { driver, schema, sessions, pending } = environment.services;
	const confirmingSessionId = await sessionIdOfCaller(environment, context);

	const account = await driver.transaction(async (transaction) => {
		const redeemed = await redeemOrRefuse(transaction, schema, {
			token: input.token,
			purpose: "magic_link",
		});
		const resolved = await accountOfRedemption(environment, transaction, redeemed);
		await confirmAddress({
			transaction,
			schema,
			actor: resolved.actor,
			confirmingSessionId,
			newEmail: null,
		});
		return resolved;
	});

	// 3.6: the second factor is not skipped because the first one was a link. Which factors the
	// account offers is read where the row is written (E-735), so the state is begun and then
	// completed at once when it turns out to offer none.
	const begun = await pending.begin({ userId: account.user.id, factorsCompleted: [] });
	if (begun.pending.availableFactors.length > 0) {
		context.cookies.setPending(begun.token);
		return { status: "second_factor_required", pendingToken: begun.token, pending: begun.pending };
	}

	await pending.consume(begun.token);
	const issued = await sessions.issue({
		userId: account.user.id,
		factors: [],
		observed: observedIn(context),
	});
	context.cookies.setSession(issued.token);
	return {
		status: "signed_in",
		sessionToken: issued.token,
		session: issued.session,
		user: await readUserOrRefuse(environment, driver, account.user.id),
	};
}
