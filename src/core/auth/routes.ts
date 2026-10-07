import { actorOfResolvedSession } from "../db/actor.js";
import type { SecondFactorCompletion } from "../factor/pending/complete.js";
import { type PendingAuthenticationService, toPendingToken } from "../factor/pending/index.js";
import type { PendingAuthentication, Session } from "../http/caller.js";
import type { Clock } from "../http/environment.js";
import { ConcealedError, VelveError } from "../http/error-map.js";
import type { RateLimitRule } from "../http/rate-limit.js";
import { defineRoute } from "../http/route.js";
import { object, string } from "../http/validators.js";
import type { IdentityConfiguration, UsernameRules } from "../identity/configuration.js";
import { comparisonFormOf } from "../identity/fold.js";
import { normaliseUsername } from "../identity/normalise.js";
import { usernameAvailability } from "../identity/resolution.js";
import type { UnboundEnvelopePolicy } from "../keys/envelope-binding.js";
import type { KeyProvider } from "../keys/index.js";
import type { OAuthConfig } from "../oauth/config.js";
import type { ResolvedPasswordConfig } from "../password/config.js";
import type { KdfSemaphore } from "../password/semaphore.js";
import type { RevokeReason } from "../plugin/config.js";
import type { PluginRuntime } from "../plugin/registry.js";
import { announceEachRevocation } from "../plugin/revocation.js";
import type { SessionResolution, SessionService } from "../session/service.js";
import type { OneTimeTokens } from "../token/one-time-token.js";
import type {
	EmailConfig,
	RateLimitConfig,
	RecoveryCodesConfig,
	TotpConfig,
	WebAuthnConfig,
} from "./config.js";
import type { User, UserRepository } from "./user.js";

export interface ResolvedSessionView {
	readonly session: Session;
	readonly user: User;
}

/** a memo for one request from each resolved session to its resolution, never a cache */
export type ResolutionMemo = WeakMap<Session, SessionResolution>;

/** what every route source takes, and the whole of what it takes */
export interface RouteServices {
	readonly sessions: SessionService;
	readonly pending: PendingAuthenticationService;
	readonly users: UserRepository;
	readonly resolutions: ResolutionMemo;
	readonly identity: IdentityConfiguration;
	readonly rateLimit: RateLimitConfig;
	readonly password: ResolvedPasswordConfig;
	readonly driver: import("../db/driver.js").Driver;
	readonly schema: string;
	readonly keys: KeyProvider;
	/** whether a ciphertext still in the unbound form of 1.x is read for a given owner */
	readonly unboundEnvelopes: UnboundEnvelopePolicy;
	readonly clock: Clock;
	readonly oneTimeTokens: OneTimeTokens;
	/** the one bound on concurrent key derivation every route source in the process shares */
	readonly kdfSemaphore: KdfSemaphore;
	readonly oauth?: OAuthConfig;
	readonly email?: EmailConfig;
	/** absent removes the seven `factor.webauthn.*` rows and the two `signIn.passkey.*` ones */
	readonly webauthn?: WebAuthnConfig;
	readonly totp?: Partial<TotpConfig>;
	readonly recoveryCodes?: RecoveryCodesConfig;
	/** the allowed origins, the only name of the application the configuration always carries */
	readonly origins: readonly string[];
	/** turns a pending row into its session in one transaction, built once */
	readonly completeSecondFactor: SecondFactorCompletion;
	/** the plugins, ordered and frozen, with their routes, contexts and seven hook points */
	readonly pluginRuntime: PluginRuntime;
	/** the fetch used for outbound provider calls, `globalThis.fetch` when absent */
	readonly fetch?: typeof globalThis.fetch;
}

export function addressOnly(services: RouteServices): RateLimitRule {
	return { perIpAddress: services.rateLimit.perIpAddress, perAccount: "none" };
}

export function addressAndAccount(services: RouteServices): RateLimitRule {
	return {
		perIpAddress: services.rateLimit.perIpAddress,
		perAccount: services.rateLimit.perAccount,
	};
}

//the account bucket must use the comparison form the account is resolved by (E-1194)
export async function accountRateLimitKeyOf(
	services: RouteServices,
	userId: string,
): Promise<string> {
	const user = await services.users.findUserById(userId);
	return comparisonFormOf(user?.email ?? user?.username ?? userId);
}

const UNLIMITED: RateLimitRule = { perIpAddress: "none", perAccount: "none" };

//username availability carries its own tight bucket of ten requests a minute (S-ENUM-8)
const USERNAME_AVAILABILITY_LIMIT: RateLimitRule = {
	perIpAddress: { capacity: 10, refillPerSecond: 10 / 60 },
	perAccount: "none",
};

function resolutionOfContext(services: RouteServices, session: Session): SessionResolution {
	const resolved = services.resolutions.get(session);
	if (resolved === undefined) {
		throw new VelveError("internal_error");
	}
	return resolved;
}

function requireSession(services: RouteServices, session: Session | null): SessionResolution {
	if (session === null) {
		throw new ConcealedError("cookie_absent");
	}
	return resolutionOfContext(services, session);
}

//every event is announced before the rows go, so a refusing hook leaves them standing (E-758)
async function announceRevocationOf(
	services: RouteServices,
	resolved: SessionResolution,
	chosen: (sessionId: string) => boolean,
	reason: RevokeReason,
): Promise<void> {
	if (!services.pluginRuntime.listensTo("beforeSessionRevoke")) {
		return;
	}
	const owned = await services.sessions.listEveryIdOwnedBy({ resolved });
	await announceEachRevocation(services.pluginRuntime, {
		userId: resolved.userId,
		sessionIds: owned.filter(chosen),
		reason,
	});
}

async function viewOf(
	services: RouteServices,
	resolved: SessionResolution,
): Promise<ResolvedSessionView | null> {
	const user = await services.users.findUserById(resolved.userId);
	return user === null ? null : { session: resolved.session, user };
}

export function sessionRoutes(services: RouteServices) {
	const signOut = defineRoute({
		name: "signOut",
		method: "POST",
		path: "/sign-out",
		input: object({}),
		errors: ["invalid_input", "rate_limited", "origin_not_allowed"] as const,
		caller: "session",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		//signing out must end only this session and must succeed for a token that names none
		handler: async (_input, context): Promise<void> => {
			if (context.sessionToken !== null) {
				if (context.session !== null) {
					await services.pluginRuntime.hooks.beforeSessionRevoke({
						sessionId: context.session.id,
						userId: context.session.userId,
						reason: "sign_out",
					});
				}
				await services.sessions.signOut({ token: context.sessionToken });
			}
			context.cookies.clearSession();
		},
	});

	const read = defineRoute({
		name: "session.read",
		method: "GET",
		path: "/session",
		input: object({}),
		errors: ["account_disabled", "origin_not_allowed"] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: UNLIMITED,
		//this runs on every request, so a counter on it would block the application itself
		handler: async (_input, context): Promise<ResolvedSessionView | null> => {
			if (context.sessionToken === null) {
				return null;
			}
			const resolved = await services.sessions.resolve(context.sessionToken);
			return resolved === null ? null : viewOf(services, resolved);
		},
	});

	const list = defineRoute({
		name: "session.list",
		method: "GET",
		path: "/session/list",
		input: object({}),
		errors: [
			"session_required",
			"freshness_required",
			"account_disabled",
			"rate_limited",
			"origin_not_allowed",
		] as const,
		caller: "session",
		freshness: "required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		handler: async (_input, context): Promise<Session[]> =>
			services.sessions.list({ resolved: requireSession(services, context.session) }),
	});

	const revoke = defineRoute({
		name: "session.revoke",
		method: "POST",
		path: "/session/revoke",
		input: object({ targetSessionId: string() }),
		errors: [
			"invalid_input",
			"session_required",
			"freshness_required",
			"account_disabled",
			"rate_limited",
			"origin_not_allowed",
		] as const,
		caller: "session",
		freshness: "required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		//a foreign or missing session must answer alike (S-OWNER-8)
		handler: async (input, context): Promise<void> => {
			const resolved = requireSession(services, context.session);
			await announceRevocationOf(
				services,
				resolved,
				(sessionId) => sessionId === input.targetSessionId,
				"revoked_by_user",
			);
			await services.sessions.revoke({ resolved, targetSessionId: input.targetSessionId });
		},
	});

	const revokeAllOther = defineRoute({
		name: "session.revokeAllOther",
		method: "POST",
		path: "/session/revoke-others",
		input: object({}),
		errors: [
			"session_required",
			"freshness_required",
			"account_disabled",
			"rate_limited",
			"origin_not_allowed",
		] as const,
		caller: "session",
		freshness: "required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		handler: async (_input, context): Promise<{ revokedCount: number }> => {
			const resolved = requireSession(services, context.session);
			await announceRevocationOf(
				services,
				resolved,
				(sessionId) => sessionId !== resolved.session.id,
				"revoked_by_user",
			);
			return services.sessions.revokeEveryOther({ resolved });
		},
	});

	const revokeAll = defineRoute({
		name: "session.revokeAll",
		method: "POST",
		path: "/session/revoke-all",
		input: object({}),
		errors: [
			"session_required",
			"freshness_required",
			"account_disabled",
			"rate_limited",
			"origin_not_allowed",
		] as const,
		caller: "session",
		freshness: "required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		handler: async (_input, context): Promise<{ revokedCount: number }> => {
			const resolved = requireSession(services, context.session);
			await announceRevocationOf(services, resolved, () => true, "revoked_by_user");
			return services.sessions.revokeEvery({ resolved });
		},
	});

	const refresh = defineRoute({
		name: "session.refresh",
		method: "POST",
		path: "/session/refresh",
		input: object({}),
		errors: ["session_required", "account_disabled", "rate_limited", "origin_not_allowed"] as const,
		caller: "session",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		//refresh only extends the idle timeout, never the absolute deadline or the token
		handler: async (_input, context): Promise<ResolvedSessionView | null> => {
			if (context.sessionToken === null) {
				throw new ConcealedError("cookie_absent");
			}
			const refreshed = await services.sessions.refresh(context.sessionToken);
			return refreshed === null ? null : viewOf(services, refreshed);
		},
	});

	return [signOut, read, list, revoke, revokeAllOther, revokeAll, refresh] as const;
}

/** the two pending routes, which read the pending cookie but are not authorised by it */
export function pendingRoutes(services: RouteServices) {
	const read = defineRoute({
		name: "pending.read",
		method: "GET",
		path: "/pending",
		input: object({}),
		errors: ["origin_not_allowed"] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: UNLIMITED,
		pendingCookie: "readable",
		//the pending state names the factors still open and never any user data
		handler: async (_input, context): Promise<PendingAuthentication | null> => {
			if (context.pendingToken === null) {
				return null;
			}
			const resolved = await services.pending.resolve(toPendingToken(context.pendingToken));
			return resolved === null ? null : resolved.pending;
		},
	});

	const cancel = defineRoute({
		name: "pending.cancel",
		method: "POST",
		path: "/pending/cancel",
		input: object({}),
		errors: ["invalid_input", "rate_limited", "origin_not_allowed"] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		pendingCookie: "readable",
		//the cookie goes whether or not a row was there, so a cancelled attempt cannot be replayed
		handler: async (_input, context): Promise<void> => {
			if (context.pendingToken !== null) {
				await services.pending.cancel({ token: toPendingToken(context.pendingToken) });
			}
			context.cookies.clearPending();
		},
	});

	return [read, cancel] as const;
}

export interface UsernameAvailabilityAnswer {
	readonly available: boolean;
	readonly reason?: string;
}

const UNIQUE_VIOLATION = "23505";

//drivers name the SQLSTATE field differently but all carry the five characters sent
function isUniqueViolation(cause: unknown): boolean {
	if (typeof cause !== "object" || cause === null) {
		return false;
	}
	const fields = cause as { readonly code?: unknown; readonly sqlState?: unknown };
	return fields.code === UNIQUE_VIOLATION || fields.sqlState === UNIQUE_VIOLATION;
}

/** the one place the enumeration protection ends, bounded hard and offered only with usernames */
export function usernameRoutes(services: RouteServices, rules: UsernameRules) {
	const isAvailable = defineRoute({
		name: "username.isAvailable",
		method: "GET",
		path: "/username/available",
		input: object({ username: string() }),
		errors: ["invalid_input", "rate_limited", "origin_not_allowed"] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: USERNAME_AVAILABILITY_LIMIT,
		handler: async (input): Promise<UsernameAvailabilityAnswer> =>
			usernameAvailability({
				driver: services.driver,
				schema: services.schema,
				rules,
				candidate: input.username,
			}),
	});

	const change = defineRoute({
		name: "username.change",
		method: "POST",
		path: "/username/change",
		input: object({ newUsername: string() }),
		errors: [
			"invalid_input",
			"session_required",
			"freshness_required",
			"account_disabled",
			"username_taken",
			"username_invalid",
			"rate_limited",
			"origin_not_allowed",
		] as const,
		caller: "session",
		freshness: "required",
		originCheck: "checked",
		rateLimit: addressAndAccount(services),
		//only core identity normalises the name, so written and resolved forms are one (E-1246)
		handler: async (input, context): Promise<{ readonly user: User }> => {
			const resolved = requireSession(services, context.session);
			await context.enforceAccountRateLimit(await accountRateLimitKeyOf(services, resolved.userId));
			const normalised = normaliseUsername(input.newUsername, rules);
			if (!normalised.accepted) {
				throw new VelveError("username_invalid");
			}
			//the unique index decides, so the race between the two statements loses here
			const changed = await services.users
				.updateUsername({
					actor: actorOfResolvedSession(resolved),
					username: normalised.value.username,
					usernameKey: normalised.value.usernameKey,
				})
				.catch((cause: unknown) => {
					if (isUniqueViolation(cause)) {
						throw new VelveError("username_taken");
					}
					throw cause;
				});
			//an account deleted after its session resolved leaves the caller without a session (E-2835)
			if (changed === null) {
				throw new ConcealedError("session_not_found");
			}
			return { user: changed };
		},
	});

	return [isAvailable, change] as const;
}
