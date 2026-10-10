import type { RouteServices } from "../auth/routes.js";
import { type Actor, actorOfResolvedSession } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { observedIn } from "../flows/environment.js";
import type { SetPasswordResult } from "../flows/results.js";
import { ConcealedError, type ConcealedReason, VelveError } from "../http/error-map.js";
import type { RequestContext } from "../http/route.js";
import { equalsInConstantTime } from "../keys/constant-time.js";
import { announceEachRevocation } from "../plugin/revocation.js";
import { createSessionUnderHooks } from "../plugin/sign-in.js";
import type { SecurityStateRead } from "../security-state/read.js";
import { sealChange } from "../security-state/runtime.js";
import { componentsAfter } from "../security-state/sealing.js";
import { sessionRowsOn } from "../session/rows.js";
import type { IssuedSession, SessionResolution } from "../session/service.js";
import { randomUuid } from "../token/random.js";
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
	const standing = await sessionRowsOn(services.sessions, transaction).listEverySessionIdOwnedBy({
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

const REFUSAL_BY_PATH = {
	password_set: "session_issue_missed_on_password_set",
	password_change: "session_issue_missed_on_password_change",
} as const satisfies Record<string, ConcealedReason>;

//a set finds no password and a change finds the one it verified, both in the read under the lock (S-INTEG-4)
function refuseUnlessTheReadHoldsTheCheckedPassword(
	read: SecurityStateRead,
	checkedPhc: Uint8Array<ArrayBuffer> | null,
): void {
	if (checkedPhc === null) {
		if (read.password !== null) {
			throw new VelveError("factor_already_enrolled");
		}
		return;
	}
	if (read.password === null || !equalsInConstantTime(read.password.phc, checkedPhc)) {
		throw new ConcealedError("password_mismatch");
	}
}

//the hash is derived before the transaction so no KDF runs under a row lock (E-1185)
export async function replacePasswordOfSession(
	services: RouteServices,
	environment: PasswordEnvironment,
	context: RequestContext,
	input: {
		readonly completes: "password_set" | "password_change";
		readonly resolved: SessionResolution;
		readonly newPassword: string;
		readonly checkedPhc: Uint8Array<ArrayBuffer> | null;
	},
): Promise<SetPasswordResult> {
	const accepted = await acceptNewPassword(input.newPassword, services.password);
	const phc = await environment.semaphore.run(() =>
		createArgon2idHash(accepted.bytes, services.password.argon2id),
	);

	const sessionId = randomUuid();
	const actor = actorOfResolvedSession(input.resolved);
	//a credential change is a mass revocation and draws a new session epoch with its seal (S-INTEG-3)
	const writeTheChange = async () => {
		const outcome: { reissued?: IssuedSession & { revokedOtherSessionsCount: number } } = {};
		await sealChange(
			services.securityState,
			actor,
			{
				epoch: "raise",
				write: async (transaction, read) => {
					//a call whose session a concurrent credential change revoked is refused as that first (E-2701)
					refuseUnlessCallingSessionIsAmong(
						await sessionRowsOn(services.sessions, transaction).listEverySessionIdOwnedBy({
							actor,
						}),
						input.resolved,
					);
					refuseUnlessTheReadHoldsTheCheckedPassword(read, input.checkedPhc);
					//a refused revocation must refuse the change before anything is written (S-RACE-5)
					await announceEverySessionAboutToBeDeleted(services, transaction, input.resolved);
					const deleted = await sessionRowsOn(
						services.sessions,
						transaction,
					).deleteEverySessionOwnedByReturningIds({ actor });
					//a session a concurrent credential change revoked must not be reissued (E-2701)
					refuseUnlessCallingSessionIsAmong(deleted, input.resolved);
					const stored = await createPasswordCredentialRepository({
						driver: transaction,
						keys: services.keys,
						schema: services.schema,
						memoryCeilingKiB: storedMemoryCeilingKiB(services.password.argon2id.memoryKiB),
					}).write({
						actor,
						phc,
						//the password is recorded as set by the session this change issues (E-626)
						setBySessionId: sessionId,
						scheme: CREATED_SCHEME,
					});
					return { stored, deletedCount: deleted.length };
				},
				after: (read, written) =>
					componentsAfter(read, {
						password: {
							phc: written.stored.ciphertext,
							keyVersion: written.stored.keyVersion,
							scheme: CREATED_SCHEME,
							setBySessionId: sessionId,
						},
					}),
				afterSeal: async (transaction, sealed, written) => {
					const issued = await services.sessions.boundTo(transaction).issue({
						completes: input.completes,
						authorisedBy: sealed,
						userId: input.resolved.userId,
						factors: ["password"],
						observed: observedIn(context),
						sessionId,
					});
					outcome.reissued = { ...issued, revokedOtherSessionsCount: written.deletedCount - 1 };
				},
			},
			{ refusal: REFUSAL_BY_PATH[input.completes] },
		);
		if (outcome.reissued === undefined) {
			throw new VelveError("internal_error");
		}
		return outcome.reissued;
	};
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
