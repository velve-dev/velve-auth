import type { RouteServices } from "../auth/routes.js";
import { type Actor, actorOfResolvedSession } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { lockAccountRow } from "../db/lock.js";
import type { SessionRepository } from "../db/repositories/session.js";
import { observedIn } from "../flows/environment.js";
import type { SetPasswordResult } from "../flows/results.js";
import { ConcealedError, VelveError } from "../http/error-map.js";
import type { RequestContext } from "../http/route.js";
import { announceEachRevocation } from "../plugin/revocation.js";
import { createSessionUnderHooks } from "../plugin/sign-in.js";
import type { SessionResolution } from "../session/service.js";
import { createArgon2idHash } from "./argon2.js";
import { createPasswordCredentialRepository } from "./credential.js";
import { storedMemoryCeilingKiB } from "./limits.js";
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

function sessionRowsOn(transaction: Driver, services: RouteServices): SessionRepository {
	return services.sessions.repositoryOn(transaction);
}

function refuseUnlessCallingSessionIsAmong(
	sessionIds: readonly string[],
	resolved: SessionResolution,
): void {
	if (!sessionIds.includes(resolved.session.id)) {
		throw new ConcealedError("session_not_found");
	}
}

async function announceEverySessionAboutToBeDeleted(
	services: RouteServices,
	transaction: Driver,
	resolved: SessionResolution,
): Promise<void> {
	if (!services.pluginRuntime.listensTo("beforeSessionRevoke")) {
		return;
	}
	const standing = await sessionRowsOn(transaction, services).listEverySessionIdOwnedBy({
		actor: actorOfResolvedSession(resolved),
	});
	//a call that is going to be refused announces nothing (E-2705)
	refuseUnlessCallingSessionIsAmong(standing, resolved);
	await announceEachRevocation(
		services.pluginRuntime,
		{ userId: resolved.userId, sessionIds: standing, reason: "password_changed" },
		transaction,
	);
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

	const writeTheChange = () =>
		services.driver.transaction(async (transaction) => {
			//the account row comes first as a first confirmation writes these tables in reverse (E-1602)
			await lockAccountRow(transaction, services.schema, input.resolved.userId);
			//a refused revocation must refuse the change before anything is written (S-RACE-5)
			await announceEverySessionAboutToBeDeleted(services, transaction, input.resolved);
			const deleted = await sessionRowsOn(
				transaction,
				services,
			).deleteEverySessionOwnedByReturningIds({ actor: actorOfResolvedSession(input.resolved) });
			//a session a concurrent credential change revoked must not be reissued (E-2701)
			refuseUnlessCallingSessionIsAmong(deleted, input.resolved);
			const reissued = await services.sessions.boundTo(transaction).issue({
				userId: input.resolved.userId,
				factors: ["password"],
				observed: observedIn(context),
			});
			await createPasswordCredentialRepository({
				driver: transaction,
				keys: services.keys,
				schema: services.schema,
				memoryCeilingKiB: storedMemoryCeilingKiB(services.password.argon2id.memoryKiB),
			}).write({
				actor: actorOfResolvedSession(input.resolved),
				phc,
				//the password is recorded as set by the session this change just issued (E-626)
				setBySessionId: reissued.session.id,
				scheme: CREATED_SCHEME,
			});
			return { ...reissued, revokedOtherSessionsCount: deleted.length - 1 };
		});
	//the account is known from the session so the veto runs before the transaction opens (E-2796)
	const issued = await createSessionUnderHooks(
		services.pluginRuntime.hooks,
		{ userId: input.resolved.userId, factors: ["password"] },
		writeTheChange,
	);

	context.cookies.setSession(issued.token);
	return {
		sessionToken: issued.token,
		session: issued.session,
		revokedOtherSessionsCount: issued.revokedOtherSessionsCount,
	};
}
