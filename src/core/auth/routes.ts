import { type PendingAuthenticationService, toPendingToken } from "../factor/pending/index.js";
import type { PendingAuthentication, Session } from "../http/caller.js";
import type { Clock } from "../http/environment.js";
import { ConcealedError, VelveError } from "../http/error-map.js";
import type { RateLimitRule } from "../http/rate-limit.js";
import { defineRoute } from "../http/route.js";
import { object, string } from "../http/validators.js";
import type { IdentityConfiguration, UsernameRules } from "../identity/configuration.js";
import { usernameAvailability } from "../identity/resolution.js";
import type { KeyProvider } from "../keys/index.js";
import type { OAuthConfig } from "../oauth/config.js";
import type { ResolvedPasswordConfig } from "../password/config.js";
import type { VelvePlugin } from "../plugin/config.js";
import type { SessionResolution, SessionService } from "../session/service.js";
import type { OneTimeTokens } from "../token/one-time-token.js";
import type { EmailConfig, RateLimitConfig } from "./config.js";
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

/** The three seam modules take this and nothing else, so the seven fields below are declared here rather than by whichever feature reaches for one first, and no core route reads any of them yet (E-719). */
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
	readonly oauth?: OAuthConfig;
	readonly email?: EmailConfig;
	readonly plugins?: readonly VelvePlugin[];
	/** 3.10's outbound calls; absent means `globalThis.fetch`. */
	readonly fetch?: typeof globalThis.fetch;
}

function addressOnly(services: RouteServices): RateLimitRule {
	return { perIpAddress: services.rateLimit.perIpAddress, perAccount: "none" };
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
			await services.sessions.revoke({
				resolved: requireSession(services, context.session),
				targetSessionId: input.targetSessionId,
			});
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
		handler: async (_input, context): Promise<{ revokedCount: number }> =>
			services.sessions.revokeEveryOther({ resolved: requireSession(services, context.session) }),
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
		handler: async (_input, context): Promise<{ revokedCount: number }> =>
			services.sessions.revokeEvery({ resolved: requireSession(services, context.session) }),
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

	return [isAvailable] as const;
}
