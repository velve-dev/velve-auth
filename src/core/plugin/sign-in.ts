import type { AuthenticationFactor, Session } from "../http/caller.js";
import type { ObservedRequest } from "../session/service.js";
import type { SessionCreateEvent, SignInEvent } from "./config.js";
import type { PluginHookDispatcher } from "./registry.js";

type SignInMethod = SignInEvent["method"];

//the hook is told no account so it runs alike for an existing and a missing one (S-TIM-1)
export function askBeforeSignIn(
	hooks: PluginHookDispatcher,
	method: SignInMethod,
	observed: ObservedRequest,
): Promise<void> {
	return hooks.beforeSignIn({
		method,
		userId: null,
		ipAddress: observed.ipAddress,
		userAgent: observed.userAgent,
	});
}

//the veto must come before the session is written and never take a second connection (E-2795)
export async function createSessionUnderHooks<Written extends { readonly session: Session }>(
	hooks: PluginHookDispatcher,
	intended: SessionCreateEvent,
	write: () => Promise<Written>,
): Promise<Written> {
	await hooks.beforeSessionCreate({ userId: intended.userId, factors: intended.factors });
	const written = await write();
	await tellAfterSessionCreate(hooks, written.session);
	return written;
}

export function tellAfterSessionCreate(
	hooks: PluginHookDispatcher,
	session: Session,
): Promise<void> {
	return hooks.afterSessionCreate({
		userId: session.userId,
		factors: session.factors,
		sessionId: session.id,
	});
}

export function tellAfterSignIn(
	hooks: PluginHookDispatcher,
	completed: {
		readonly method: SignInMethod;
		readonly observed: ObservedRequest;
		readonly session: Session;
		readonly signCountRegressed?: boolean;
	},
): Promise<void> {
	return hooks.afterSignIn({
		method: completed.method,
		userId: completed.session.userId,
		ipAddress: completed.observed.ipAddress,
		userAgent: completed.observed.userAgent,
		sessionId: completed.session.id,
		factors: completed.session.factors,
		...(completed.signCountRegressed === undefined
			? {}
			: { signCountRegressed: completed.signCountRegressed }),
	});
}

//a magic link is the one first factor that leaves no factor on the pending row
export function signInMethodOfFirstFactor(
	factorsCompleted: readonly AuthenticationFactor[],
): SignInMethod {
	if (factorsCompleted.includes("password")) {
		return "password";
	}
	if (factorsCompleted.includes("oauth")) {
		return "oauth";
	}
	return "magic_link";
}
