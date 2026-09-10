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
import { toPendingToken } from "./pending/index.js";
import { createRecoveryCodeService, type RecoveryCodeService } from "./recovery/index.js";
import { createTotpService, type TotpEnrollment, type TotpService } from "./totp/index.js";
import type { WebAuthnCredential } from "./webauthn/credential-repository.js";
import {
	createWebAuthnService,
	type WebAuthnAuthenticationChallenge,
	type WebAuthnRegistrationChallenge,
	type WebAuthnService,
} from "./webauthn/service.js";

/** What the authenticator hands back, checked for shape by `unknownRecord` and judged by the verifier. */
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

/**
 * 3.15 B declares `factor.webauthn` beside the other two without a condition, and A.2 makes the
 * absence of `webauthn` remove its routes rather than its type — so the namespace is declared here
 * unconditionally and is absent at run time wherever nothing configured it (E-1244).
 */
export type FactorSurface = {
	readonly factor: {
		readonly totp: TotpNamespace;
		readonly webauthn: WebAuthnNamespace;
		readonly recovery: RecoveryNamespace;
	};
	readonly signIn: { readonly passkey: SignInPasskeyNamespace };
};

/**
 * A.8 gives `issuer` no default and A.2 makes `totp` itself optional, while D.3 counts the four
 * TOTP rows in every configuration — so they have to mount without one. What names the application
 * in every configuration is `origins`, and its host is what an authenticator then shows (E-1243).
 */
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

/** S-OWNER-7: the actor is the resolution the pipeline produced, never a value out of the request. */
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

/** The label an authenticator shows for the account, which is whichever identifier the mode gives it. */
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

/** A GET declaring no field cannot fail its validator, so it declares no `invalid_input` either. */
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

/**
 * S-FIX-1: what the intermediate state becomes is a session written in the transaction that removes
 * the pending row, and the cookie the browser still holds for that state goes in the same answer.
 */
async function signedInBySecondFactor(
	services: RouteServices,
	context: RequestContext,
	spent: {
		readonly pendingToken: string;
		readonly factor: "totp" | "webauthn" | "recovery";
		readonly signCountRegressed?: boolean;
	},
): Promise<SignInResult> {
	const issued = await services.completeSecondFactor.complete({
		pendingToken: toPendingToken(spent.pendingToken),
		factor: spent.factor,
		observed: { ipAddress: context.ipAddress, userAgent: context.userAgent },
	});
	const user = await services.users.findUserById(issued.session.userId);
	if (user === null) {
		throw new ConcealedError("user_not_found");
	}
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

/**
 * S-RATE-7 on a route whose caller is a cookie rather than an identifier: the bucket is keyed by
 * the account's own comparison form and is spent before the code is judged, so the cheapest
 * possible attempt is not the one that costs nothing (E-1196).
 */
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
		// 3.6: the row is written with `confirmed_at = NULL`, so an abandoned attempt guards nothing.
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
				pendingToken: held.token,
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
		// B.6: whoever can remove the factor without holding it has no factor.
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
		/** B.6: the whole set is drawn and the previous one deleted in one transaction, and the plaintext leaves the process here and once. */
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
				pendingToken: held.token,
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
		/** B.6: a count and nothing else — what is stored is the HMAC of each code. */
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
		// B.6: `label` is required — three entries all called "Security key" is not a list anyone can act on.
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
		handler: async (input, context): Promise<SignInResult> => {
			const held = heldPendingState(context);
			await spendAccountToken(services, context, held.resolution.userId);
			const assertion = await webauthn.authenticate.finish({
				pending: held.resolution,
				challengeToken: input.challengeToken,
				response: input.response as unknown as AuthenticationResponseJSON,
			});
			return signedInBySecondFactor(services, context, {
				pendingToken: held.token,
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
		// S-OWNER-3 and L-13: a credential of another account and an invented one answer alike, and
		// the account's last remaining way in is refused rather than removed.
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
		/** 3.6: nothing names an account — the authenticator offers a discoverable credential and the account is learned from the answer. */
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
		/** B.1 and 3.6: a way in of its own, so the session records `webauthn` alone and no intermediate state took part. */
		handler: async (input, context): Promise<SignInResult> => {
			const assertion = await webauthn.passkey.finish({
				challengeToken: input.challengeToken,
				response: input.response as unknown as AuthenticationResponseJSON,
			});
			const user = await services.users.findUserById(assertion.userId);
			// L-4: a disabled account answers a valid assertion as an invalid one, and never with its own code.
			if (user === null || user.disabledAt !== null) {
				throw new ConcealedError("user_disabled_on_webauthn_assertion");
			}
			const issued = await services.sessions.issue({
				userId: assertion.userId,
				factors: ["webauthn"],
				observed: { ipAddress: context.ipAddress, userAgent: context.userAgent },
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

/** Every row this file can contribute, in the order it assembles them (E-671's reason, for 3.15 E). */
export type FactorRouteTable = readonly [
	...ReturnType<typeof totpRoutes>,
	...ReturnType<typeof recoveryRoutes>,
	...ReturnType<typeof webAuthnRoutes>,
	...ReturnType<typeof passkeyRoutes>,
];

/**
 * The fourteen `factor/*` rows of 3.15 D.3 and the two `sign-in/passkey/*` ones. D.3 counts the
 * TOTP and recovery rows in every configuration and says of the other nine that without `webauthn`
 * they do not exist — so the narrowing below is the configuration and nothing else (E-1242).
 */
export function factorRoutes(services: RouteServices): readonly AnyRoute[] {
	const totp: TotpService = createTotpService({
		driver: services.driver,
		schema: services.schema,
		keys: services.keys,
		clock: services.clock,
		pending: services.pending,
		issuer: totpIssuerOf(services),
	});
	const recovery: RecoveryCodeService = createRecoveryCodeService({
		driver: services.driver,
		schema: services.schema,
		keys: services.keys,
		pending: services.pending,
	});
	const alwaysMounted = [...totpRoutes(services, totp), ...recoveryRoutes(services, recovery)];
	if (services.webauthn === undefined) {
		return alwaysMounted;
	}
	const webauthn: WebAuthnService = createWebAuthnService({
		driver: services.driver,
		schema: services.schema,
		webauthn: services.webauthn,
	});
	return [
		...alwaysMounted,
		...webAuthnRoutes(services, webauthn),
		...passkeyRoutes(services, webauthn),
	];
}
