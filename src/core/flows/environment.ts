import type { EmailConfig } from "../auth/config.js";
import type { RouteServices } from "../auth/routes.js";
import { createUserRepository, type User } from "../auth/user.js";
import { type Actor, actorOfRedeemedOneTimeToken } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { ConcealedError } from "../http/error-map.js";
import type { RequestContext } from "../http/route.js";
import type { KdfSemaphore } from "../password/semaphore.js";
import type { ObservedRequest } from "../session/service.js";
import type { OneTimeTokenRedemption } from "../token/one-time-token.js";
import type { ArtefactMailer } from "./artefact.js";

export interface FlowEnvironment {
	readonly services: RouteServices;
	/** S-DOS-3: the same bound the sign-in path is under, so a sign-up wave cannot displace it. */
	readonly semaphore: KdfSemaphore;
}

export function observedIn(context: RequestContext): ObservedRequest {
	return { ipAddress: context.ipAddress, userAgent: context.userAgent };
}

export function mailerOf(environment: FlowEnvironment, email: EmailConfig): ArtefactMailer {
	return { driver: environment.services.driver, schema: environment.services.schema, email };
}

/** An account that vanished between a redemption and this read is answered as the token is. */
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

/**
 * S-TOKEN-4: the account a redemption acts on is the one the removed row named, and this is the
 * only way this feature reaches an account from a redeeming route — no input field and no cookie
 * takes part in it.
 */
interface RedeemedAccount {
	readonly actor: Actor;
	readonly user: User;
}

export async function accountOfRedemption(
	environment: FlowEnvironment,
	driver: Driver,
	redemption: OneTimeTokenRedemption,
): Promise<RedeemedAccount> {
	const user = await readUserOrRefuse(environment, driver, redemption.userId);
	// L-4 keeps the disabled-account code to the resolution of an existing session, and a
	// redemption is not one, so a disabled account answers here as an invented token does.
	if (user.disabledAt !== null) {
		throw new ConcealedError("user_disabled_on_token_redemption");
	}
	return { actor: actorOfRedeemedOneTimeToken(redemption), user };
}

/**
 * The session the confirming request arrived with, or `null` when it carried none or the token in
 * it names nothing. L-12 reads `null` as a different session, so a request whose session cannot be
 * resolved fails closed towards the attacker path rather than towards the credential (S-LINK-4).
 */
export async function sessionIdOfCaller(
	environment: FlowEnvironment,
	context: RequestContext,
): Promise<string | null> {
	if (context.sessionToken === null) {
		return null;
	}
	const resolved = await environment.services.sessions
		.resolve(context.sessionToken)
		.catch(() => null);
	return resolved === null ? null : resolved.session.id;
}
