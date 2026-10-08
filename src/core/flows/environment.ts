import type { EmailConfig } from "../auth/config.js";
import type { RouteServices } from "../auth/routes.js";
import { createUserRepository, type User } from "../auth/user.js";
import { type Actor, actorOfRedeemedOneTimeToken } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { ConcealedError } from "../http/error-map.js";
import type { RequestContext } from "../http/route.js";
import type { KdfSemaphore } from "../password/semaphore.js";
import { type AccountCheck, checkAccount } from "../security-state/runtime.js";
import type { ObservedRequest } from "../session/service.js";
import type { OneTimeTokenRedemption } from "../token/one-time-token.js";
import { type ArtefactMailer, refuseUnlessTheAddressIsStillTheAccounts } from "./artefact.js";

export interface FlowEnvironment {
	readonly services: RouteServices;
	/** the key derivation bound sign-in is under, which a sign-up wave cannot displace */
	readonly semaphore: KdfSemaphore;
}

export function observedIn(context: RequestContext): ObservedRequest {
	return { ipAddress: context.ipAddress, userAgent: context.userAgent };
}

export function mailerOf(environment: FlowEnvironment, email: EmailConfig): ArtefactMailer {
	const { driver, schema, keys } = environment.services;
	return { driver, schema, keys, email };
}

//an account that vanished after a redemption must answer as the token does
export async function readUserOrRefuse(
	environment: FlowEnvironment,
	driver: Driver,
	userId: string,
): Promise<User> {
	const user = await createUserRepository({
		driver,
		schema: environment.services.schema,
	}).findUserById(userId);
	if (user === null) {
		throw new ConcealedError("token_not_found");
	}
	return user;
}

//a redemption may reach an account only through the removed row (S-TOKEN-4)
interface RedeemedAccount {
	readonly actor: Actor;
	readonly user: User;
	/** the seal check the redemption passed, which a session it issues is bound to */
	readonly check: Extract<AccountCheck, { kind: "usable" }>;
}

export const A_DISABLED_ACCOUNT = Symbol("a redemption for a disabled account");

//every redemption commits the spent token before it refuses a disabled account (E-2880)
//a redemption checks the seal before its token has any effect and compares the address it read with it (S-INTEG-4)
export async function accountOrDisabledOfRedemption(
	environment: FlowEnvironment,
	driver: Driver,
	redemption: OneTimeTokenRedemption,
): Promise<RedeemedAccount | typeof A_DISABLED_ACCOUNT> {
	const check = await checkAccount(
		environment.services.securityState,
		redemption.userId,
		"token_redemption",
		{ driver },
	);
	if (check.kind === "missing") {
		throw new ConcealedError("token_not_found");
	}
	if (check.kind === "broken") {
		throw new ConcealedError("broken_state_on_token_redemption");
	}
	refuseUnlessTheAddressIsStillTheAccounts(environment.services, redemption, check.read.email);
	const user = await readUserOrRefuse(environment, driver, redemption.userId);
	if (check.read.disabled) {
		return A_DISABLED_ACCOUNT;
	}
	return { actor: actorOfRedeemedOneTimeToken(redemption), user, check };
}

//a disabled account must answer a redemption as an invented token does
export function refuseADisabledAccount(): never {
	throw new ConcealedError("user_disabled_on_token_redemption");
}

//a vanished account behind a session must answer as an unresolved session (E-615)
export async function readAccountOfSession(
	environment: FlowEnvironment,
	userId: string,
): Promise<User> {
	const user = await environment.services.users.findUserById(userId);
	if (user === null) {
		throw new ConcealedError("session_not_found");
	}
	return user;
}

/** the session a confirmation was presented with, which counts only for the account it belongs to */
export interface ConfirmingSession {
	readonly sessionId: string;
	readonly userId: string;
}

//an unresolvable session must count as a different session and fail closed (S-LINK-4)
export async function sessionOfCaller(
	environment: FlowEnvironment,
	context: RequestContext,
): Promise<ConfirmingSession | null> {
	if (context.sessionToken === null) {
		return null;
	}
	const resolved = await environment.services.sessions
		.resolve(context.sessionToken)
		.catch(() => null);
	return resolved === null ? null : { sessionId: resolved.session.id, userId: resolved.userId };
}
