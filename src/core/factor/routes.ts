import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { SignInResult } from "../auth/results.js";
import {
	accountRateLimitKeyOf,
	addressAndAccount,
	addressOnly,
	type RouteServices,
} from "../auth/routes.js";
import { type Actor, actorOfResolvedSession } from "../db/actor.js";
import type { ResolvedPendingAuthentication, Session } from "../http/caller.js";
import { ConcealedError, VelveError } from "../http/error-map.js";
import {
	type AnyRoute,
	defineRoute,
	type RequestContext,
	type ServerCallFields,
} from "../http/route.js";
import { object, string, unknownRecord } from "../http/validators.js";
import {
	askBeforeSignIn,
	createSessionUnderHooks,
	signInMethodOfFirstFactor,
	tellAfterSignIn,
} from "../plugin/sign-in.js";
import { toPendingToken, verifyUnderPendingAttemptLimit } from "./pending/index.js";
import {
	createRecoveryCodeService,
	type RecoveryCodeService,
	recoveryCodeShapeOf,
} from "./recovery/index.js";
import {
	createTotpService,
	type TotpEnrollment,
	type TotpService,
	totpToleranceOf,
} from "./totp/index.js";
import type { WebAuthnCredential } from "./webauthn/credential-repository.js";
import {
	createWebAuthnService,
	type WebAuthnAuthenticationChallenge,
	type WebAuthnRegistrationChallenge,
	type WebAuthnService,
} from "./webauthn/service.js";

/** what the authenticator hands back, checked for shape and judged by the verifier */
export type AuthenticatorResponse = Record<string, unknown>;

export interface TotpNamespace {
	readonly enroll: {
		start(input: ServerCallFields): Promise<TotpEnrollment>;
		finish(input: { code: string } & ServerCallFields): Promise<void>;
	};
	verify(input: { code: string } & ServerCallFields): Promise<SignInResult>;
	remove(input: { code: string } & ServerCallFields): Promise<void>;
}

export interface WebAuthnNamespace {
	readonly register: {
		start(input: ServerCallFields): Promise<WebAuthnRegistrationChallenge>;
		finish(
			input: {
				challengeToken: string;
				response: AuthenticatorResponse;
				label: string;
			} & ServerCallFields,
		): Promise<{ credential: WebAuthnCredential }>;
	};
	readonly authenticate: {
		start(input: ServerCallFields): Promise<WebAuthnAuthenticationChallenge>;
		finish(
			input: { challengeToken: string; response: AuthenticatorResponse } & ServerCallFields,
		): Promise<SignInResult>;
	};
	list(input: ServerCallFields): Promise<WebAuthnCredential[]>;
	rename(
		input: { credentialId: string; label: string } & ServerCallFields,
	): Promise<{ credential: WebAuthnCredential }>;
	remove(input: { credentialId: string } & ServerCallFields): Promise<void>;
}

export interface RecoveryNamespace {
	generate(input: ServerCallFields): Promise<{ codes: readonly string[] }>;
	verify(input: { code: string } & ServerCallFields): Promise<SignInResult>;
	remaining(input: ServerCallFields): Promise<{ remainingCount: number }>;
}

export interface SignInPasskeyNamespace {
	start(input: ServerCallFields): Promise<WebAuthnAuthenticationChallenge>;
	finish(
		input: { challengeToken: string; response: AuthenticatorResponse } & ServerCallFields,
	): Promise<SignInResult>;
}

/** the `factor` namespaces, with `factor.webauthn` absent at run time unless configured */
export type FactorSurface = {
	readonly factor: {
		readonly totp: TotpNamespace;
		readonly webauthn: WebAuthnNamespace;
		readonly recovery: RecoveryNamespace;
	};
	readonly signIn: { readonly passkey: SignInPasskeyNamespace };
};

//totp routes mount in every configuration so the issuer falls back to the origin host (E-1243)
function totpIssuerOf(services: RouteServices): string {
	const configured = services.totp?.issuer;
	if (configured !== undefined && configured !== "") {
		return configured;
	}
	const [first = ""] = services.origins;
	try {
		return new URL(first).host;
	} catch {
		return first;
	}
}

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

interface HeldPendingState {
	readonly resolution: ResolvedPendingAuthentication;
	readonly token: string;
}

function heldPendingState(context: RequestContext): HeldPendingState {
	if (context.pending === null || context.pendingToken === null) {
		throw new ConcealedError("pending_cookie_absent");
	}
	return { resolution: context.pending, token: context.pendingToken };
}

async function accountNameOf(services: RouteServices, actor: Actor): Promise<string> {
	const user = await services.users.findUserById(actor);
	return user?.email ?? user?.username ?? actor;
}

const SESSION_ERRORS = [
	"invalid_input",
	"session_required",
	"account_disabled",
	"rate_limited",
	"origin_not_allowed",
] as const;

const FRESH_SESSION_ERRORS = [...SESSION_ERRORS, "freshness_required"] as const;

//a get without fields cannot fail validation so it declares no invalid input
const READING_SESSION_ERRORS = [
	"session_required",
	"account_disabled",
	"rate_limited",
	"origin_not_allowed",
] as const;

const PENDING_ERRORS = [
	"invalid_input",
	"invalid_pending_authentication",
	"too_many_factor_attempts",
	"rate_limited",
	"origin_not_allowed",
] as const;

//the session is written in the transaction that removes the pending row (S-FIX-1)
async function signedInBySecondFactor(
	services: RouteServices,
	context: RequestContext,
	spent: {
		readonly held: HeldPendingState;
		readonly factor: "totp" | "webauthn" | "recovery";
		readonly signCountRegressed?: boolean;
	},
): Promise<SignInResult> {
	const observed = { ipAddress: context.ipAddress, userAgent: context.userAgent };
	const hooks = services.pluginRuntime.hooks;
	const { userId, pending } = spent.held.resolution;
	//beforeSignIn ran at the first factor and the completion is the same sign-in
	const issued = await createSessionUnderHooks(
		hooks,
		{ userId, factors: [...pending.factorsCompleted, spent.factor] },
		() =>
			services.completeSecondFactor.complete({
				pendingToken: toPendingToken(spent.held.token),
				factor: spent.factor,
				presentedSessionToken: context.sessionToken,
				observed,
			}),
	);
	const user = await services.users.findUserById(issued.session.userId);
	if (user === null) {
		throw new ConcealedError("user_not_found");
	}
	await tellAfterSignIn(hooks, {
		method: signInMethodOfFirstFactor(pending.factorsCompleted),
		observed,
		session: issued.session,
		...(spent.signCountRegressed === undefined
			? {}
			: { signCountRegressed: spent.signCountRegressed }),
	});
	context.cookies.clearPending();
	context.cookies.setSession(issued.token);
	return {
		status: "signed_in",
		sessionToken: issued.token,
		session: issued.session,
		user,
		...(spent.signCountRegressed === undefined
			? {}
			: { signCountRegressed: spent.signCountRegressed }),
	};
}

//the account bucket is spent before the code is judged so no attempt is free (E-1196)
async function spendAccountToken(
	services: RouteServices,
	context: RequestContext,
	userId: string,
): Promise<void> {
	await context.enforceAccountRateLimit(await accountRateLimitKeyOf(services, userId));
}

function totpRoutes(services: RouteServices, totp: TotpService) {
	const enrollStart = defineRoute({
		name: "factor.totp.enroll.start",
		method: "POST",
		path: "/factor/totp/enroll/start",
		input: object({}),
		errors: [...FRESH_SESSION_ERRORS, "factor_already_enrolled"] as const,
		caller: "session",
		freshness: "required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		//an unconfirmed row guards nothing so an abandoned enrolment is harmless
		handler: async (_input, context): Promise<TotpEnrollment> => {
			const actor = actorOf(services, context.session);
			return totp.enroll.start({ actor, accountName: await accountNameOf(services, actor) });
		},
	});

	const enrollFinish = defineRoute({
		name: "factor.totp.enroll.finish",
		method: "POST",
		path: "/factor/totp/enroll/finish",
		input: object({ code: string() }),
		errors: [
			...FRESH_SESSION_ERRORS,
			"invalid_factor_code",
			"factor_not_enrolled",
			"factor_already_enrolled",
		] as const,
		caller: "session",
		freshness: "required",
		originCheck: "checked",
		rateLimit: addressAndAccount(services),
		handler: async (input, context): Promise<void> => {
			const actor = actorOf(services, context.session);
			await spendAccountToken(services, context, actor);
			await totp.enroll.finish({ actor, code: input.code });
		},
	});

	const verify = defineRoute({
		name: "factor.totp.verify",
		method: "POST",
		path: "/factor/totp/verify",
		input: object({ code: string() }),
		errors: [...PENDING_ERRORS, "invalid_factor_code"] as const,
		caller: "pending",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressAndAccount(services),
		handler: async (input, context): Promise<SignInResult> => {
			const held = heldPendingState(context);
			await spendAccountToken(services, context, held.resolution.userId);
			await totp.verify({ pendingToken: toPendingToken(held.token), code: input.code });
			return signedInBySecondFactor(services, context, {
				held,
				factor: "totp",
			});
		},
	});

	const remove = defineRoute({
		name: "factor.totp.remove",
		method: "POST",
		path: "/factor/totp/remove",
		input: object({ code: string() }),
		errors: [...FRESH_SESSION_ERRORS, "invalid_factor_code", "factor_not_enrolled"] as const,
		caller: "session",
		freshness: "required",
		originCheck: "checked",
		rateLimit: addressAndAccount(services),
		//removing the factor must require holding it
		handler: async (input, context): Promise<void> => {
			const actor = actorOf(services, context.session);
			await spendAccountToken(services, context, actor);
			await totp.remove({ actor, code: input.code });
		},
	});

	return [enrollStart, enrollFinish, verify, remove] as const;
}

function recoveryRoutes(services: RouteServices, recovery: RecoveryCodeService) {
	const generate = defineRoute({
		name: "factor.recovery.generate",
		method: "POST",
		path: "/factor/recovery/generate",
		input: object({}),
		errors: FRESH_SESSION_ERRORS,
		caller: "session",
		freshness: "required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		//the plaintext codes must leave the process here and never again
		handler: async (_input, context): Promise<{ codes: readonly string[] }> =>
			recovery.generate({ actor: actorOf(services, context.session) }),
	});

	const verify = defineRoute({
		name: "factor.recovery.verify",
		method: "POST",
		path: "/factor/recovery/verify",
		input: object({ code: string() }),
		errors: [...PENDING_ERRORS, "invalid_recovery_code"] as const,
		caller: "pending",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressAndAccount(services),
		handler: async (input, context): Promise<SignInResult> => {
			const held = heldPendingState(context);
			await spendAccountToken(services, context, held.resolution.userId);
			await recovery.verify({ pendingToken: toPendingToken(held.token), code: input.code });
			return signedInBySecondFactor(services, context, {
				held,
				factor: "recovery",
			});
		},
	});

	const remaining = defineRoute({
		name: "factor.recovery.remaining",
		method: "GET",
		path: "/factor/recovery/remaining",
		input: object({}),
		errors: READING_SESSION_ERRORS,
		caller: "session",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		//only a count is returned as only the hmac of each code is stored
		handler: async (_input, context): Promise<{ remainingCount: number }> =>
			recovery.remaining({ actor: actorOf(services, context.session) }),
	});

	return [generate, verify, remaining] as const;
}

function webAuthnRoutes(services: RouteServices, webauthn: WebAuthnService) {
	const registerStart = defineRoute({
		name: "factor.webauthn.register.start",
		method: "POST",
		path: "/factor/webauthn/register/start",
		input: object({}),
		errors: FRESH_SESSION_ERRORS,
		caller: "session",
		freshness: "required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		handler: async (_input, context): Promise<WebAuthnRegistrationChallenge> => {
			const actor = actorOf(services, context.session);
			return webauthn.register.start({ actor, userName: await accountNameOf(services, actor) });
		},
	});

	const registerFinish = defineRoute({
		name: "factor.webauthn.register.finish",
		method: "POST",
		path: "/factor/webauthn/register/finish",
		input: object({ challengeToken: string(), response: unknownRecord(), label: string() }),
		errors: [
			...FRESH_SESSION_ERRORS,
			"webauthn_challenge_invalid",
			"webauthn_credential_rejected",
		] as const,
		caller: "session",
		freshness: "required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		//a label is required so several credentials stay distinguishable
		handler: async (input, context): Promise<{ credential: WebAuthnCredential }> =>
			webauthn.register.finish({
				actor: actorOf(services, context.session),
				challengeToken: input.challengeToken,
				response: input.response as unknown as RegistrationResponseJSON,
				label: input.label,
			}),
	});

	const authenticateStart = defineRoute({
		name: "factor.webauthn.authenticate.start",
		method: "POST",
		path: "/factor/webauthn/authenticate/start",
		input: object({}),
		errors: [
			"invalid_input",
			"invalid_pending_authentication",
			"factor_not_enrolled",
			"rate_limited",
			"origin_not_allowed",
		] as const,
		caller: "pending",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		handler: async (_input, context): Promise<WebAuthnAuthenticationChallenge> =>
			webauthn.authenticate.start({ pending: heldPendingState(context).resolution }),
	});

	const authenticateFinish = defineRoute({
		name: "factor.webauthn.authenticate.finish",
		method: "POST",
		path: "/factor/webauthn/authenticate/finish",
		input: object({ challengeToken: string(), response: unknownRecord() }),
		errors: [
			...PENDING_ERRORS,
			"webauthn_challenge_invalid",
			"webauthn_credential_rejected",
		] as const,
		caller: "pending",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressAndAccount(services),
		//the five attempts per pending state are shared by every factor (E-1691)
		handler: async (input, context): Promise<SignInResult> => {
			const held = heldPendingState(context);
			await spendAccountToken(services, context, held.resolution.userId);
			const assertion = await verifyUnderPendingAttemptLimit(
				services.pending,
				toPendingToken(held.token),
				(resolution) =>
					webauthn.authenticate.finish({
						pending: resolution,
						challengeToken: input.challengeToken,
						response: input.response as unknown as AuthenticationResponseJSON,
					}),
			);
			return signedInBySecondFactor(services, context, {
				held,
				factor: "webauthn",
				signCountRegressed: assertion.signCountRegressed,
			});
		},
	});

	const list = defineRoute({
		name: "factor.webauthn.list",
		method: "GET",
		path: "/factor/webauthn/list",
		input: object({}),
		errors: READING_SESSION_ERRORS,
		caller: "session",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		handler: async (_input, context): Promise<WebAuthnCredential[]> =>
			webauthn.list({ actor: actorOf(services, context.session) }),
	});

	const rename = defineRoute({
		name: "factor.webauthn.rename",
		method: "POST",
		path: "/factor/webauthn/rename",
		input: object({ credentialId: string(), label: string() }),
		errors: SESSION_ERRORS,
		caller: "session",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		handler: async (input, context): Promise<{ credential: WebAuthnCredential }> =>
			webauthn.rename({
				actor: actorOf(services, context.session),
				credentialId: input.credentialId,
				label: input.label,
			}),
	});

	const remove = defineRoute({
		name: "factor.webauthn.remove",
		method: "POST",
		path: "/factor/webauthn/remove",
		input: object({ credentialId: string() }),
		errors: [...FRESH_SESSION_ERRORS, "last_sign_in_method"] as const,
		caller: "session",
		freshness: "required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		//another account's credential and an invented one must answer alike (S-OWNER-3)
		handler: async (input, context): Promise<void> =>
			webauthn.remove({
				actor: actorOf(services, context.session),
				credentialId: input.credentialId,
			}),
	});

	return [
		registerStart,
		registerFinish,
		authenticateStart,
		authenticateFinish,
		list,
		rename,
		remove,
	] as const;
}

function passkeyRoutes(services: RouteServices, webauthn: WebAuthnService) {
	const start = defineRoute({
		name: "signIn.passkey.start",
		method: "POST",
		path: "/sign-in/passkey/start",
		input: object({}),
		errors: ["invalid_input", "rate_limited", "origin_not_allowed"] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		//nothing names an account as it is learned from the discoverable credential
		handler: async (): Promise<WebAuthnAuthenticationChallenge> => webauthn.passkey.start(),
	});

	const finish = defineRoute({
		name: "signIn.passkey.finish",
		method: "POST",
		path: "/sign-in/passkey/finish",
		input: object({ challengeToken: string(), response: unknownRecord() }),
		errors: [
			"invalid_input",
			"webauthn_challenge_invalid",
			"webauthn_credential_rejected",
			"rate_limited",
			"origin_not_allowed",
		] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		//a passkey is a way in of its own so the session records webauthn alone
		handler: async (input, context): Promise<SignInResult> => {
			const observed = { ipAddress: context.ipAddress, userAgent: context.userAgent };
			const hooks = services.pluginRuntime.hooks;
			await askBeforeSignIn(hooks, "passkey", observed);
			const assertion = await webauthn.passkey.finish({
				challengeToken: input.challengeToken,
				response: input.response as unknown as AuthenticationResponseJSON,
			});
			const user = await services.users.findUserById(assertion.userId);
			//a disabled account answers a valid assertion as an invalid one
			if (user === null || user.disabledAt !== null) {
				throw new ConcealedError("user_disabled_on_webauthn_assertion");
			}
			const issued = await createSessionUnderHooks(
				hooks,
				{ userId: assertion.userId, factors: ["webauthn"] },
				() =>
					services.sessions.issueReplacingPresented({
						completes: "passkey_sign_in",
						presentedToken: context.sessionToken,
						userId: assertion.userId,
						factors: ["webauthn"],
						observed,
					}),
			);
			await tellAfterSignIn(hooks, {
				method: "passkey",
				observed,
				session: issued.session,
				signCountRegressed: assertion.signCountRegressed,
			});
			context.cookies.setSession(issued.token);
			return {
				status: "signed_in",
				sessionToken: issued.token,
				session: issued.session,
				user,
				signCountRegressed: assertion.signCountRegressed,
			};
		},
	});

	return [start, finish] as const;
}

/** every second factor route, in the order they are assembled */
export type FactorRouteTable = readonly [
	...ReturnType<typeof totpRoutes>,
	...ReturnType<typeof recoveryRoutes>,
	...ReturnType<typeof webAuthnRoutes>,
	...ReturnType<typeof passkeyRoutes>,
];

//without webauthn configured its routes do not exist (E-1242)
export function factorRoutes(services: RouteServices): readonly AnyRoute[] {
	const totp: TotpService = createTotpService({
		driver: services.driver,
		schema: services.schema,
		keys: services.keys,
		clock: services.clock,
		pending: services.pending,
		issuer: totpIssuerOf(services),
		toleranceInSteps: totpToleranceOf(services.totp?.stepToleranceInSteps),
	});
	const recovery: RecoveryCodeService = createRecoveryCodeService({
		driver: services.driver,
		schema: services.schema,
		keys: services.keys,
		pending: services.pending,
		shape: recoveryCodeShapeOf(services.recoveryCodes),
	});
	const alwaysMounted = [...totpRoutes(services, totp), ...recoveryRoutes(services, recovery)];
	if (services.webauthn === undefined) {
		return alwaysMounted;
	}
	const webauthn: WebAuthnService = createWebAuthnService({
		driver: services.driver,
		schema: services.schema,
		keys: services.keys,
		webauthn: services.webauthn,
	});
	return [
		...alwaysMounted,
		...webAuthnRoutes(services, webauthn),
		...passkeyRoutes(services, webauthn),
	];
}
