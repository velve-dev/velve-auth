import type { RouteServices } from "../auth/routes.js";
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
	userId: string,
): Promise<void> {
	// 3.15 B.9 gives `password.set` the code `factor_already_enrolled`; B.4 makes overwriting an
	// existing credential without the current one the gap `set` and `change` exist to keep shut.
	if ((await environment.credentials.findByUserId(userId)) !== null) {
		throw new VelveError("factor_already_enrolled");
	}
}

/**
 * S-FIX-6 and B.4: the calling session is re-issued and every other session of the account goes,
 * with no option to keep them. S-RACE-5 puts the re-issue and the write in one transaction, and the
 * hash is derived before it opens so no KDF runs while a row lock is held (E-1185).
 */
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
			userId: input.resolved.userId,
			phc,
			// L-12: the session that stored the password is the one this change just issued.
			setBySessionId: reissued.session.id,
			scheme: CREATED_SCHEME,
		});
		return reissued;
	});

	context.cookies.setSession(issued.token);
	return {
		sessionToken: issued.token,
		session: issued.session,
		// E-611 subtracts the calling session only where there is one, and here there is.
		revokedOtherSessionsCount: Math.max(owned.length - 1, 0),
	};
}
