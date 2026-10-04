import type { Session } from "../http/caller.js";
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

//the veto must be settled before the session is written and outside its transaction (E-973)
export async function createSessionUnderHooks<Written extends { readonly session: Session }>(
	hooks: PluginHookDispatcher,
	intended: SessionCreateEvent,
	write: () => Promise<Written>,
): Promise<Written> {
	await hooks.beforeSessionCreate({ userId: intended.userId, factors: intended.factors });
	const written = await write();
	await hooks.afterSessionCreate({
		userId: written.session.userId,
		factors: written.session.factors,
		sessionId: written.session.id,
	});
	return written;
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
