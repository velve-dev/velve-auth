import type { EmailConfig } from "../auth/config.js";
import type { SignInResult } from "../auth/results.js";
import type { RequestContext } from "../http/route.js";
import { normaliseEmail } from "../identity/normalise.js";
import { askBeforeSignIn, createSessionUnderHooks, tellAfterSignIn } from "../plugin/sign-in.js";
import { recordSealLater } from "../security-state/runtime.js";
import { mintArtefact, redeemOrRefuse, sendOrUndo, subjectOfAddress } from "./artefact.js";
import { confirmAddress } from "./confirmation.js";
import {
	A_DISABLED_ACCOUNT,
	accountOrDisabledOfRedemption,
	type FlowEnvironment,
	mailerOf,
	observedIn,
	readUserOrRefuse,
	refuseADisabledAccount,
	sessionOfCaller,
} from "./environment.js";

//both branches must run the same statements and call send exactly once (S-TIM-6)
export async function requestMagicLink(
	environment: FlowEnvironment,
	email: EmailConfig,
	context: RequestContext,
	input: { readonly email: string },
): Promise<void> {
	const normalised = normaliseEmail(input.email);
	//a malformed address must cost the same lookup as one that names nobody (E-46)
	const address = normalised.accepted ? normalised.value : "";
	await context.enforceAccountRateLimit(address);

	const owner = await environment.services.users.findUserByEmail(address);
	const { driver } = environment.services;
	const minted = await driver.transaction((transaction) =>
		mintArtefact(transaction, environment.services, {
			purpose: "magic_link",
			subject: subjectOfAddress(owner, address),
			accountEmail: owner?.email ?? address,
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

//redeeming a magic link confirms the address and removes a foreign password (S-LINK-4)
export async function redeemMagicLink(
	environment: FlowEnvironment,
	context: RequestContext,
	input: { readonly token: string },
): Promise<SignInResult> {
	const { driver, schema, sessions, pending } = environment.services;
	const hooks = environment.services.pluginRuntime.hooks;
	const observed = observedIn(context);
	//a veto must come before the token is spent so the link can still be used
	await askBeforeSignIn(hooks, "magic_link", observed);
	const confirmingSession = await sessionOfCaller(environment, context);

	const account = await driver.transaction(async (transaction) => {
		const redeemed = await redeemOrRefuse(transaction, environment.services, {
			token: input.token,
			purpose: "magic_link",
		});
		const resolved = await accountOrDisabledOfRedemption(environment, transaction, redeemed);
		//a link presented for a disabled account stays spent once it is enabled again (E-2880)
		if (resolved === A_DISABLED_ACCOUNT) {
			return resolved;
		}
		const confirmed = await confirmAddress({
			transaction,
			schema,
			pluginRuntime: environment.services.pluginRuntime,
			sessions: environment.services.sessions,
			actor: resolved.actor,
			confirmingSession,
			newEmail: null,
			securityState: environment.services.securityState,
		});
		return {
			...resolved,
			sealed: confirmed.sealed,
			secondFactors: confirmed.secondFactors,
			toRecord: confirmed.toRecord,
		};
	});
	if (account === A_DISABLED_ACCOUNT) {
		refuseADisabledAccount();
	}
	recordSealLater(environment.services.securityState, account.toRecord, "token_redemption");

	//a link as the first factor must not skip the second factor (E-735)
	//the session and the pending row are bound to the seal the redemption wrote (S-INTEG-9)
	const begun = await pending.begin({
		userId: account.user.id,
		factorsCompleted: [],
		sessionEpoch: account.sealed.sessionEpoch,
		offered: { factors: account.secondFactors, refusal: "broken_state_on_token_redemption" },
	});
	if (begun.pending.availableFactors.length > 0) {
		context.cookies.setPending(begun.token);
		return { status: "second_factor_required", pendingToken: begun.token, pending: begun.pending };
	}

	//a pending row that names no factor is withdrawn and the issue alone answers a race (E-3404)
	await pending.cancel({ token: begun.token });
	const issued = await createSessionUnderHooks(
		hooks,
		{ userId: account.user.id, factors: [] },
		() =>
			sessions.issueReplacingPresented({
				completes: "magic_link",
				authorisedBy: account.sealed,
				presentedToken: context.sessionToken,
				userId: account.user.id,
				factors: [],
				observed,
			}),
	);
	const user = await readUserOrRefuse(environment, driver, account.user.id);
	await tellAfterSignIn(hooks, { method: "magic_link", observed, session: issued.session });
	context.cookies.setSession(issued.token);
	return {
		status: "signed_in",
		sessionToken: issued.token,
		session: issued.session,
		user,
	};
}
