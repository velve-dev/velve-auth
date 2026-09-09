import type { Identity, OAuthRedirect } from "../auth/results.js";
import type { RouteServices } from "../auth/routes.js";
import { type Actor, actorOfResolvedSession } from "../db/actor.js";
import type { IdentityMode } from "../db/migrations/identity-mode.js";
import type { Session } from "../http/caller.js";
import { ConcealedError, VelveError } from "../http/error-map.js";
import type { RateLimitRule } from "../http/rate-limit.js";
import { defineRoute, type RequestContext, type ServerSurface } from "../http/route.js";
import { object, optional, string } from "../http/validators.js";
import { resolveProviderTable } from "./providers.js";
import {
	createOAuthService,
	type OAuthCallbackOutcome,
	type OAuthService,
	type StartedFlow,
} from "./service.js";

function addressOnly(services: RouteServices): RateLimitRule {
	return { perIpAddress: services.rateLimit.perIpAddress, perAccount: "none" };
}

/** S-OWNER-7: the actor comes from the resolution the pipeline produced, never from the request. */
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

function userIdOf(services: RouteServices, session: Session | null): string {
	return actorOf(services, session);
}

/** 3.15 C: the pointer reaches the browser as a cookie and the caller as a `CookieInstruction`. */
function answerWithStatePointer(context: RequestContext, started: StartedFlow): OAuthRedirect {
	if (started.delivery === "form_post") {
		context.cookies.setCrossSiteOAuthState(started.pointer);
	} else {
		context.cookies.setOAuthState(started.pointer);
	}
	return started.redirect;
}

const CALLBACK_INPUT = object({
	provider: string(),
	code: string(),
	state: string(),
	iss: optional(string()),
});

const CALLBACK_ERRORS = [
	"invalid_input",
	"oauth_flow_invalid",
	"oauth_provider_error",
	"identity_already_linked",
	"rate_limited",
] as const;

/**
 * The rows of 3.15 D.3 that begin `/sign-in/oauth/` and `/identity/`, declared by the feature that
 * owns third-party sign-in. The table is composed here so that adding them is a change to this
 * file and never to the assembly — and the tuple return type is what carries the names into
 * `VelveAuth`, so `signIn.oauth.*` appears on the instance without `instance.ts` being edited.
 */
export function oauthRoutes(services: RouteServices) {
	const providers = resolveProviderTable(services.oauth);
	const oauth: OAuthService = createOAuthService({ services, providers });

	function completeFlow(
		input: { provider: string; code: string; state: string; iss?: string },
		context: RequestContext,
	): Promise<OAuthCallbackOutcome> {
		context.cookies.clearOAuthState();
		return oauth.completeFlow({
			providerId: input.provider,
			code: input.code,
			state: input.state,
			iss: input.iss ?? null,
			pointer: context.oauthStateToken,
			sessionToken: context.sessionToken,
			observed: { ipAddress: context.ipAddress, userAgent: context.userAgent },
		});
	}

	const start = defineRoute({
		name: "signIn.oauth.start",
		method: "POST",
		path: "/sign-in/oauth/start",
		input: object({ provider: string(), redirectPath: optional(string()) }),
		errors: [
			"invalid_input",
			"provider_not_configured",
			"rate_limited",
			"origin_not_allowed",
		] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		handler: async (input, context): Promise<OAuthRedirect> =>
			answerWithStatePointer(
				context,
				await oauth.beginFlow({
					providerId: input.provider,
					...(input.redirectPath === undefined ? {} : { redirectPath: input.redirectPath }),
					linkToUserId: null,
				}),
			),
	});

	/**
	 * S-CSRF-1: the one route of the specification without an origin check — the provider redirects
	 * a browser here by GET and no `Origin` header exists to check. What secures it is the
	 * server-side state, the pointer cookie and PKCE (3.10, S-CSRF-5).
	 */
	const callback = defineRoute({
		name: "signIn.oauth.callback",
		method: "GET",
		path: "/sign-in/oauth/callback/:provider",
		input: CALLBACK_INPUT,
		errors: CALLBACK_ERRORS,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "exempt",
		rateLimit: addressOnly(services),
		oauthStateCookie: "readable",
		handler: completeFlow,
	});

	/**
	 * The second exempt route, and the reason T-CSRF-1's threshold is two: `responseMode: form_post`
	 * is what Apple requires once the e-mail scope is asked for (section 1, C50 and C70), and a
	 * provider posting a form carries no `Origin` the library may compare either (E-541).
	 */
	const callbackFormPost = defineRoute({
		name: "signIn.oauth.callbackFormPost",
		method: "POST",
		path: "/sign-in/oauth/callback/:provider",
		input: CALLBACK_INPUT,
		errors: CALLBACK_ERRORS,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "exempt",
		rateLimit: addressOnly(services),
		oauthStateCookie: "readable",
		requestBody: "form",
		handler: completeFlow,
	});

	const list = defineRoute({
		name: "identity.list",
		method: "GET",
		path: "/identity/list",
		input: object({}),
		errors: ["session_required", "account_disabled", "rate_limited", "origin_not_allowed"] as const,
		caller: "session",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		/** C89: the provider, the subject, the address and the scopes — never a token. */
		handler: async (_input, context): Promise<Identity[]> =>
			oauth.listIdentities({ actor: actorOf(services, context.session) }),
	});

	const linkStart = defineRoute({
		name: "identity.link.start",
		method: "POST",
		path: "/identity/link/start",
		input: object({ provider: string(), redirectPath: optional(string()) }),
		errors: [
			"invalid_input",
			"session_required",
			"freshness_required",
			"account_disabled",
			"provider_not_configured",
			"rate_limited",
			"origin_not_allowed",
		] as const,
		caller: "session",
		freshness: "required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		/** 3.15 B.7: the account to link to is fixed here, server-side, and cannot come from the callback. */
		handler: async (input, context): Promise<OAuthRedirect> =>
			answerWithStatePointer(
				context,
				await oauth.beginFlow({
					providerId: input.provider,
					...(input.redirectPath === undefined ? {} : { redirectPath: input.redirectPath }),
					linkToUserId: userIdOf(services, context.session),
				}),
			),
	});

	const unlink = defineRoute({
		name: "identity.unlink",
		method: "POST",
		path: "/identity/unlink",
		input: object({ identityId: string() }),
		errors: [
			"invalid_input",
			"session_required",
			"freshness_required",
			"account_disabled",
			"last_sign_in_method",
			"rate_limited",
			"origin_not_allowed",
		] as const,
		caller: "session",
		freshness: "required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		// S-OWNER-4: an identity of another account and one that never existed both change nothing.
		handler: async (input, context): Promise<void> => {
			await oauth.unlinkIdentity({
				actor: actorOf(services, context.session),
				identityId: input.identityId,
			});
		},
	});

	return [start, callback, callbackFormPost, list, linkStart, unlink] as const;
}

/**
 * What this feature contributes to `VelveAuth<M>`. It is declared here rather than in the assembly
 * so that adding a namespace is a change to this file; `M` is a parameter because a namespace may
 * exist in one identity mode and not another (E-776).
 */
export type OAuthSurface<M extends IdentityMode> = M extends IdentityMode
	? ServerSurface<ReturnType<typeof oauthRoutes>>
	: never;
