import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { addressAndAccount, addressOnly, type RouteServices } from "../auth/routes.js";
import { type Actor, actorOfResolvedSession } from "../db/actor.js";
import type { IdentityMode } from "../db/migrations/identity-mode.js";
import type { WebAuthnRegistrationChallenge } from "../factor/webauthn/service.js";
import type { Session } from "../http/caller.js";
import { ConcealedError, VelveError } from "../http/error-map.js";
import { guardedByProofOfWork } from "../http/proof-of-work.js";
import { type AnyRoute, defineRoute, type ServerCallFields } from "../http/route.js";
import { object, string, unknownRecord } from "../http/validators.js";
import type { PasskeyRecoveryActivation } from "./activation.js";
import type { PasskeyRecoveryConfig } from "./config.js";
import {
	cancelPasskeyRecovery,
	type FinishPasskeyRecoveryResult,
	finishPasskeyRecovery,
	type PasskeyRecoveryEnvironment,
	type PendingPasskeyRecovery,
	readPendingPasskeyRecovery,
	requestPasskeyRecovery,
	startPasskeyRecovery,
} from "./flow.js";

/** the recovery to a new passkey: the address, the mailed link with one recovery code, the new passkey, and the notice */
export interface PasskeyRecoveryNamespace {
	request(input: { email: string } & ServerCallFields): Promise<void>;
	start(
		input: { token: string; recoveryCode: string } & ServerCallFields,
	): Promise<WebAuthnRegistrationChallenge>;
	finish(
		input: {
			challengeToken: string;
			response: Record<string, unknown>;
			label: string;
		} & ServerCallFields,
	): Promise<FinishPasskeyRecoveryResult>;
	pending(input: ServerCallFields): Promise<PendingPasskeyRecovery | null>;
	cancel(input: ServerCallFields): Promise<void>;
}

/** the `passkeyRecovery` namespace, present at run time only where `webauthn.recovery` is configured */
export type PasskeyRecoverySurface<M extends IdentityMode> = M extends "email" | "username_email"
	? { readonly passkeyRecovery: PasskeyRecoveryNamespace }
	: unknown;

//the actor is the pipeline's resolution, never a value out of the request (S-OWNER-7)
function actorOf(services: RouteServices, session: Session | null): Actor {
	if (session === null) {
		throw new ConcealedError("cookie_absent");
	}
	const resolved = services.resolutions.get(session);
	if (resolved === undefined) {
		throw new VelveError("internal_error");
	}
	return actorOfResolvedSession(resolved);
}

const ANONYMOUS_ERRORS = ["invalid_input", "rate_limited", "origin_not_allowed"] as const;

const FAILING_STEP_ERRORS = [...ANONYMOUS_ERRORS, "passkey_recovery_failed"] as const;

function recoveryRoutesOf(environment: PasskeyRecoveryEnvironment) {
	const { services } = environment.flow;

	const request = defineRoute({
		name: "passkeyRecovery.request",
		method: "POST",
		path: "/passkey-recovery/request",
		input: object({ email: string() }),
		errors: [...ANONYMOUS_ERRORS, "proof_of_work_required"] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressAndAccount(services),
		//the request answers void as a sent flag would be the enumeration answer
		handler: async (input, context): Promise<void> =>
			requestPasskeyRecovery(environment, context, input),
	});
	//the request mails an address, so it asks for a proof on every call (S-RATE-11)
	guardedByProofOfWork(request, { when: "always" });

	const start = defineRoute({
		name: "passkeyRecovery.start",
		method: "POST",
		path: "/passkey-recovery/start",
		input: object({ token: string(), recoveryCode: string() }),
		errors: FAILING_STEP_ERRORS,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressAndAccount(services),
		handler: async (input, context): Promise<WebAuthnRegistrationChallenge> =>
			startPasskeyRecovery(environment, context, input),
	});

	const finish = defineRoute({
		name: "passkeyRecovery.finish",
		method: "POST",
		path: "/passkey-recovery/finish",
		input: object({ challengeToken: string(), response: unknownRecord(), label: string() }),
		errors: FAILING_STEP_ERRORS,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		handler: async (input): Promise<FinishPasskeyRecoveryResult> =>
			finishPasskeyRecovery(environment, {
				challengeToken: input.challengeToken,
				response: input.response as unknown as RegistrationResponseJSON,
				label: input.label,
			}),
	});

	const pending = defineRoute({
		name: "passkeyRecovery.pending",
		method: "GET",
		path: "/passkey-recovery",
		input: object({}),
		errors: ["session_required", "account_disabled", "rate_limited", "origin_not_allowed"] as const,
		caller: "session",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		//any session of the account sees the recovery since the mailbox may be the attacker's (S-LINK-9)
		handler: async (_input, context): Promise<PendingPasskeyRecovery | null> =>
			readPendingPasskeyRecovery(environment, actorOf(services, context.session)),
	});

	const cancel = defineRoute({
		name: "passkeyRecovery.cancel",
		method: "POST",
		path: "/passkey-recovery/cancel",
		input: object({}),
		errors: ["session_required", "account_disabled", "rate_limited", "origin_not_allowed"] as const,
		caller: "session",
		//any session of the account still signed in cancels as the owner may have no way to sign in again (E-3780)
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		handler: async (_input, context): Promise<void> =>
			cancelPasskeyRecovery(environment, actorOf(services, context.session)),
	});

	return [request, start, finish, pending, cancel] as const;
}

/** every route the recovery to a new passkey contributes, in the order they are assembled */
export type PasskeyRecoveryRouteTable = ReturnType<typeof recoveryRoutesOf>;

//without webauthn.recovery, an address and a send callback the recovery has no routes (E-3761)
export function passkeyRecoveryRoutes(
	activation: PasskeyRecoveryActivation | null,
	recovery: {
		readonly webauthn: PasskeyRecoveryEnvironment["webauthn"];
		readonly config: PasskeyRecoveryConfig | undefined;
	},
): readonly AnyRoute[] {
	if (activation === null || recovery.config === undefined) {
		return [];
	}
	return recoveryRoutesOf({ ...activation, webauthn: recovery.webauthn, config: recovery.config });
}
