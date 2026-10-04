import type { RouteServices } from "../auth/routes.js";
import { type Actor, actorOfResolvedSession } from "../db/actor.js";
import { lockAccountRow } from "../db/lock.js";
import { observedIn } from "../flows/environment.js";
import type { SetPasswordResult } from "../flows/results.js";
import { VelveError } from "../http/error-map.js";
import type { RequestContext } from "../http/route.js";
import type { SessionResolution } from "../session/service.js";
import { createArgon2idHash } from "./argon2.js";
import { createPasswordCredentialRepository } from "./credential.js";
import { acceptNewPassword } from "./policy.js";
import { CREATED_SCHEME } from "./scheme.js";
import type { PasswordEnvironment } from "./verify.js";

export async function refuseIfCredentialExists(
	environment: PasswordEnvironment,
	actor: Actor,
): Promise<void> {
	//set never replaces a stored PHC credential without the current password
	if ((await environment.credentials.findOwnedBy({ actor })) !== null) {
		throw new VelveError("factor_already_enrolled");
	}
}

//the hash is derived before the transaction so no KDF runs under a row lock (E-1185)
export async function replacePasswordOfSession(
	services: RouteServices,
	environment: PasswordEnvironment,
	context: RequestContext,
	input: { readonly resolved: SessionResolution; readonly newPassword: string },
): Promise<SetPasswordResult> {
	const accepted = await acceptNewPassword(input.newPassword, services.password);
	const phc = await environment.semaphore.run(() =>
		createArgon2idHash(accepted.bytes, services.password.argon2id),
	);

	const owned = await services.sessions.listEveryIdOwnedBy({ resolved: input.resolved });

	const issued = await services.driver.transaction(async (transaction) => {
		//the account row comes first as a first confirmation writes these tables in reverse (E-1602)
		await lockAccountRow(transaction, services.schema, input.resolved.userId);
		const reissued = await services.sessions.boundTo(transaction).reissueAfterCredentialChange({
			resolved: input.resolved,
			factors: ["password"],
			observed: observedIn(context),
		});
		await createPasswordCredentialRepository({
			driver: transaction,
			keys: services.keys,
			schema: services.schema,
		}).write({
			actor: actorOfResolvedSession(input.resolved),
			phc,
			//the password is recorded as set by the session this change just issued (E-626)
			setBySessionId: reissued.session.id,
			scheme: CREATED_SCHEME,
		});
		return reissued;
	});

	context.cookies.setSession(issued.token);
	return {
		sessionToken: issued.token,
		session: issued.session,
		//the calling session is subtracted from the count only where one exists (E-611)
		revokedOtherSessionsCount: Math.max(owned.length - 1, 0),
	};
}
