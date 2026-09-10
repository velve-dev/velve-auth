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
import type { KeyProvider } from "../keys/index.js";
import type { OAuthConfig } from "../oauth/config.js";
import type { ResolvedPasswordConfig } from "../password/config.js";
import type { KdfSemaphore } from "../password/semaphore.js";
import type { RevokeReason } from "../plugin/config.js";
import type { PluginRuntime } from "../plugin/registry.js";
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

/**
 * The pipeline hands the handler a `Session`; minting an actor needs the whole `SessionResolution`,
 * and asking the database a second time would make T-CACHE-1's ratio two. The resolver puts the
 * resolution it just produced here, keyed by the very object it produced with it — a memo for one
 * request, not a cache: the key is a new object every time, so nothing survives the response.
 */
export type ResolutionMemo = WeakMap<Session, SessionResolution>;

/**
 * What every route source takes, and the whole of what it takes. The fields are declared here
 * rather than by whichever feature reaches for one first (E-719); the count is deliberately not
 * stated, because a number in a sentence is checked by nobody and went stale the moment this
 * interface grew (E-1262).
 */
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
	readonly clock: Clock;
	readonly oneTimeTokens: OneTimeTokens;
	/**
	 * S-DOS-3 bounds concurrent key derivation for the whole process, so the bound is one object
	 * every route source shares rather than one each of them makes (E-1195).
	 */
	readonly kdfSemaphore: KdfSemaphore;
	readonly oauth?: OAuthConfig;
	readonly email?: EmailConfig;
	/** 3.15 A.2: absent removes the seven `factor.webauthn.*` rows and the two `signIn.passkey.*` ones. */
	readonly webauthn?: WebAuthnConfig;
	readonly totp?: Partial<TotpConfig>;
	readonly recoveryCodes?: RecoveryCodesConfig;
	/** The allowed origins of 3.15 A.2, which is also the only name of the application the configuration always carries. */
	readonly origins: readonly string[];
	/** S-FIX-1: the pending row and the session it becomes are one transaction, and it is built once (E-410). */
	readonly completeSecondFactor: SecondFactorCompletion;
	/** The configured plugins, ordered and frozen: their routes, their contexts and the seven hook points. */
	readonly pluginRuntime: PluginRuntime;
	/** 3.10's outbound calls; absent means `globalThis.fetch`. */
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

/**
 * S-RATE-7: a route that names no identifier still has to key its account bucket by one, and it is
 * the same comparison form the account is resolved through — two forms that disagree are two
 * buckets for one account, which is a limit that can be walked around by spelling (E-1194).
 */
export async function accountRateLimitKeyOf(
	services: RouteServices,
	userId: string,
): Promise<string> {
	const user = await services.users.findUserById(userId);
	return comparisonFormOf(user?.email ?? user?.username ?? userId);
}

const UNLIMITED: RateLimitRule = { perIpAddress: "none", perAccount: "none" };

/** S-ENUM-8: `GET /username/available` carries its own tight bucket, ten requests a minute. */
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

/**
 * 3.11: the hook may refuse by throwing, so every event is announced before the rows go and the
 * refusal leaves them standing. Listing first costs a statement, which is why it is skipped
 * entirely where no plugin listens (E-758).
 */
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
	for (const sessionId of owned.filter(chosen)) {
		await services.pluginRuntime.hooks.beforeSessionRevoke({
			sessionId,
			userId: resolved.userId,
			reason,
		});
	}
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
		// 3.15 B.1: exactly one session row goes, and an unknown token is not an error.
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
		/** B.9: this runs on every request of the application, so a counter on it is a self-block. */
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
		// S-OWNER-4, S-OWNER-8: a session of another user and one that never existed answer alike.
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
		/** B.2: this forces the idle write and nothing else — never the absolute deadline, never a new token. */
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

/**
 * 3.15 D.3 rows `GET /pending` and `POST /pending/cancel`. Neither is authorised by the
 * intermediate state — reading it and cancelling it are what a caller does when it has one —
 * so both declare `pendingCookie: "readable"` rather than `caller: "pending"` (E-335, E-516).
 */
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
		/** B.7: the state names the factors still open and never any user data. */
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
		// The cookie goes whether or not a row was there, so a cancelled attempt cannot be replayed.
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

/** `pg` and `postgres.js` name it `code`, the test connection names it `sqlState`; both carry the five characters PostgreSQL sent. */
function isUniqueViolation(cause: unknown): boolean {
	if (typeof cause !== "object" || cause === null) {
		return false;
	}
	const fields = cause as { readonly code?: unknown; readonly sqlState?: unknown };
	return fields.code === UNIQUE_VIOLATION || fields.sqlState === UNIQUE_VIOLATION;
}

/**
 * S-ENUM-8: the one place the enumeration protection ends, and 3.4 decided to offer it, bound it
 * hard and say so. It exists only where usernames do.
 */
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
		/**
		 * 3.15 B.5. The name is normalised by `core/identity` and never here, so the form that is
		 * written and the form the account is later resolved through are the one form (E-1246).
		 */
		handler: async (input, context): Promise<{ readonly user: User }> => {
			const resolved = requireSession(services, context.session);
			await context.enforceAccountRateLimit(await accountRateLimitKeyOf(services, resolved.userId));
			const normalised = normaliseUsername(input.newUsername, rules);
			if (!normalised.accepted) {
				throw new VelveError("username_invalid");
			}
			// The unique index is what decides, so the race between the two statements loses here
			// rather than writing a name the index would have refused.
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
			if (changed === null) {
				throw new ConcealedError("user_not_found");
			}
			return { user: changed };
		},
	});

	return [isAvailable, change] as const;
}
