import type { Identity, OAuthRedirect } from "../auth/results.js";
import type { RouteServices } from "../auth/routes.js";
import { type Actor, actorOfResolvedSession } from "../db/actor.js";
import type { IdentityMode } from "../db/migrations/identity-mode.js";
import type { Session } from "../http/caller.js";
import { ConcealedError, VelveError } from "../http/error-map.js";
import type { RateLimitRule } from "../http/rate-limit.js";
import { answerWithRedirect } from "../http/redirect.js";
import { defineRoute, type RequestContext, type ServerSurface } from "../http/route.js";
import { object, optional, string } from "../http/validators.js";
import type { OAuthLinkStart } from "./flow-repository.js";
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

//the actor must come from the resolved session and never from the request (S-OWNER-7)
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

//the callback is not sent the session cookie, so the session to replace is fixed here (E-588)
function linkStartOf(services: RouteServices, session: Session | null): OAuthLinkStart {
	if (session === null) {
		throw new ConcealedError("cookie_absent");
	}
	return { actor: actorOf(services, session), sessionId: session.id };
}

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

/** the third-party sign-in and identity routes, typed so their names reach the instance */
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
			presentedSessionToken: context.sessionToken,
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
					linkTo: null,
				}),
			),
	});

	//a provider redirect carries no Origin, so this route has no origin check (S-CSRF-1)
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

	//a provider posting a form carries no Origin either, so this route is exempt too (E-541)
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

	//the two callbacks are the only routes whose output becomes a Location (S-REDIR-3)
	answerWithRedirect(callback);
	answerWithRedirect(callbackFormPost);

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
		//a listed identity must never carry a token
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
		handler: async (input, context): Promise<OAuthRedirect> =>
			answerWithStatePointer(
				context,
				await oauth.beginFlow({
					providerId: input.provider,
					...(input.redirectPath === undefined ? {} : { redirectPath: input.redirectPath }),
					linkTo: linkStartOf(services, context.session),
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
		//a foreign or missing identity must change nothing and answer the same (S-OWNER-8)
		handler: async (input, context): Promise<void> => {
			await oauth.unlinkIdentity({
				actor: actorOf(services, context.session),
				identityId: input.identityId,
			});
		},
	});

	return [start, callback, callbackFormPost, list, linkStart, unlink] as const;
}

/** the OAuth namespaces this feature adds to the instance, per identity mode */
export type OAuthSurface<M extends IdentityMode> = M extends IdentityMode
	? ServerSurface<ReturnType<typeof oauthRoutes>>
	: never;
