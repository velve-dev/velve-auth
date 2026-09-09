import type { Driver } from "../db/driver.js";
import type { MigrationReport } from "../db/migration.js";
import { runMigrations } from "../db/migration-runner.js";
import type { IdentityMode } from "../db/migrations/identity-mode.js";
import { coreMigrations } from "../db/migrations/index.js";
import { createSessionRepository } from "../db/repositories/session.js";
import { createOneTimeTokenRepository } from "../db/repositories/token.js";
import {
	createPendingAuthenticationService,
	type PendingAuthenticationService,
	type PendingToken,
} from "../factor/pending/index.js";
import { emailFlowRoutes } from "../flows/routes.js";
import type { CallerResolver, PendingAuthentication, Session } from "../http/caller.js";
import type { Clock, HttpEnvironment } from "../http/environment.js";
import { ConcealedError, VELVE_ERROR_CODES, type VelveErrorCode } from "../http/error-map.js";
import type { AnyRoute, ServerCallFields } from "../http/route.js";
import { createServerMethod } from "../http/server-method.js";
import { resolveIdentityConfiguration } from "../identity/configuration.js";
import { createRateLimiter } from "../limit/index.js";
import { oauthRoutes } from "../oauth/routes.js";
import { resolvePasswordConfig } from "../password/config.js";
import { assertStoredKeyVersionsAreKnown } from "../password/startup.js";
import type { FrozenContextServices } from "../plugin/context.js";
import { assertNoCoreRouteIsOverwritten, createPluginRuntime } from "../plugin/registry.js";
import { pluginRoutes } from "../plugin/routes.js";
import { sessionSettingsOf } from "../session/config.js";
import { createSessionService, type SessionService } from "../session/service.js";
import { createOneTimeTokens } from "../token/one-time-token.js";
import type { ModeHasUsername, VelveAuthConfig } from "./config.js";
import { type SweepReport, sweepExpiredRows } from "./maintenance.js";
import { rateLimitConfigOf, routeFloodWatchOf } from "./rate-limiting.js";
import {
	pendingRoutes,
	type ResolutionMemo,
	type ResolvedSessionView,
	type RouteServices,
	sessionRoutes,
	type UsernameAvailabilityAnswer,
	usernameRoutes,
} from "./routes.js";
import { type ChosenWeakening, weakeningsIn } from "./security-options.js";
import { assertConfigurationIsStartable, assertKeysAnswerForEveryPurpose } from "./startup.js";
import { createUserRepository, type User } from "./user.js";

const DEFAULT_SCHEMA = "velve";
const MILLISECONDS_IN_A_SECOND = 1000;

const NO_SINK: HttpEnvironment["log"] = () => undefined;

const ERROR_CODES = VELVE_ERROR_CODES;

/**
 * 3.15 B names the namespaces of the instance surface. A plugin id equal to one of them would put
 * its routes under a key the surface already owns, so the registry refuses it at start (3.11).
 */
const RESERVED_SURFACE_NAMESPACES: readonly string[] = [
	"signUp",
	"signIn",
	"signOut",
	"session",
	"user",
	"password",
	"factor",
	"identity",
	"pending",
	"email",
	"username",
	"routes",
	"identityMode",
	"errorCodes",
	"maintenance",
	"migrate",
	"close",
	"http",
];

export interface SessionNamespace {
	resolve(input: { sessionToken: string } & ServerCallFields): Promise<ResolvedSessionView | null>;
	list(input: ServerCallFields): Promise<Session[]>;
	revoke(input: { targetSessionId: string } & ServerCallFields): Promise<void>;
	revokeAllOther(input: ServerCallFields): Promise<{ revokedCount: number }>;
	revokeAll(input: ServerCallFields): Promise<{ revokedCount: number }>;
	refresh(input: ServerCallFields): Promise<ResolvedSessionView | null>;
}

/** B.7: the intermediate state names the factors still open and never any user data. */
export interface PendingNamespace {
	resolve(token: PendingToken): Promise<PendingAuthentication | null>;
	cancel(input: { pendingToken: PendingToken }): Promise<void>;
}

/** B.3: the surface the application calls in its own process, after its own authorization decision. */
export interface UserNamespace {
	findById(input: { userId: string }): Promise<User | null>;
	findByEmail(input: { email: string }): Promise<User | null>;
	disable(input: { userId: string; reason: string }): Promise<void>;
	enable(input: { userId: string }): Promise<void>;
	delete(input: { userId: string }): Promise<void>;
}

export interface UsernameNamespace {
	isAvailable(input: { username: string } & ServerCallFields): Promise<UsernameAvailabilityAnswer>;
}

export interface AuthInternals {
	readonly routes: readonly AnyRoute[];
	readonly identityMode: IdentityMode;
	readonly errorCodes: readonly VelveErrorCode[];
	readonly maintenance: { sweep(): Promise<SweepReport> };
	/** The one asynchronous start step, and therefore where E-179's key-ring report runs. */
	migrate(): Promise<MigrationReport>;
	close(): Promise<void>;
	/** What `toWebHandler` reads; 3.15 D.1 hands the handler the instance, not the environment. */
	readonly http: HttpEnvironment;
}

export type VelveAuth<M extends IdentityMode> = AuthInternals & {
	signOut(input: ServerCallFields): Promise<void>;
	readonly session: SessionNamespace;
	readonly pending: PendingNamespace;
	readonly user: UserNamespace;
} & (ModeHasUsername<M> extends true
		? { readonly username: UsernameNamespace }
		: Record<never, never>);

function callerResolver(
	sessions: SessionService,
	pending: PendingAuthenticationService,
	resolutions: ResolutionMemo,
): CallerResolver {
	return {
		async resolveSession(sessionToken) {
			const resolved = await sessions.resolve(sessionToken);
			if (resolved === null) {
				throw new ConcealedError("session_not_found");
			}
			resolutions.set(resolved.session, resolved);
			return resolved.session;
		},

		// S-CACHE-4: this runs for the four routes with caller "pending" and for no other.
		async resolvePending(pendingToken) {
			const resolved = await pending.resolve(pendingToken as PendingToken);
			if (resolved === null) {
				throw new ConcealedError("pending_not_found");
			}
			return resolved;
		},
	};
}

function reportedWeakenings<M extends IdentityMode>(
	config: VelveAuthConfig<M>,
	chosenFreshnessWindowMs: number,
): readonly ChosenWeakening[] {
	return weakeningsIn(config, sessionSettingsOf().freshnessWindowMs, chosenFreshnessWindowMs);
}

function report(log: HttpEnvironment["log"], weakenings: readonly ChosenWeakening[]): void {
	for (const weakening of weakenings) {
		try {
			log("warn", "a security option is weaker than its default", { ...weakening });
		} catch {
			return;
		}
	}
}

/**
 * E-231: the core reads no clock of its own, so the caller brings the one the configuration falls
 * back to. `src/index.ts` is that caller, and it is where `new Date()` is allowed.
 */
export function assembleVelveAuth<M extends IdentityMode>(
	config: VelveAuthConfig<M>,
	defaultClock: Clock,
): VelveAuth<M> {
	assertConfigurationIsStartable(config);

	const driver: Driver = config.database;
	const schema = config.schema ?? DEFAULT_SCHEMA;
	const clock = config.clock ?? defaultClock;
	const log = config.log ?? NO_SINK;
	const identity = resolveIdentityConfiguration<M>(config.identity);
	// S-DEFAULT-6: parameters below the floor are refused here, at the start, and not at the first hash.
	const password = resolvePasswordConfig(config.password);
	const sessionSettings = sessionSettingsOf(config.session);
	const rateLimit = rateLimitConfigOf(config.rateLimit);

	const sessions = createSessionService({
		driver,
		schema,
		...(config.session === undefined ? {} : { session: config.session }),
		...(config.sessionMetadata === undefined ? {} : { sessionMetadata: config.sessionMetadata }),
	});
	const pending = createPendingAuthenticationService({ driver, schema });
	const users = createUserRepository({ driver, schema });
	const resolutions: ResolutionMemo = new WeakMap();

	const oneTimeTokens = createOneTimeTokens(createOneTimeTokenRepository({ driver, schema }));

	const frozenContextServices: FrozenContextServices = {
		clock,
		identityMode: identity.mode,
		schema,
		users,
		sessions: createSessionRepository({ driver, schema }),
		driver,
		log,
	};
	// S-CSRF-6: the registry is built here and holds no route of its own; every hook it runs is
	// reached from a handler, and a handler runs after the origin check and the rate limiter.
	const pluginRuntime = createPluginRuntime({
		plugins: config.plugins ?? [],
		services: frozenContextServices,
	});

	const services: RouteServices = {
		sessions,
		pending,
		users,
		resolutions,
		identity,
		rateLimit,
		password,
		driver,
		schema,
		keys: config.keys,
		clock,
		oneTimeTokens,
		...(config.oauth === undefined ? {} : { oauth: config.oauth }),
		...(config.fetch === undefined ? {} : { fetch: config.fetch }),
		...(config.email === undefined ? {} : { email: config.email }),
		pluginRuntime,
	};

	const [signOut, read, list, revoke, revokeAllOther, revokeAll, refresh] = sessionRoutes(services);
	const pendingTable = pendingRoutes(services);
	const usernameTable =
		identity.mode === "email" ? null : usernameRoutes(services, identity.username);

	const coreRoutes: readonly AnyRoute[] = [
		signOut,
		read,
		list,
		revoke,
		revokeAllOther,
		revokeAll,
		refresh,
		...(usernameTable ?? []),
		...pendingTable,
		...oauthRoutes(services),
		...emailFlowRoutes(services),
	];
	const contributedRoutes = pluginRoutes(services);
	assertNoCoreRouteIsOverwritten(contributedRoutes, coreRoutes, RESERVED_SURFACE_NAMESPACES);

	const environment: HttpEnvironment = {
		routes: [...coreRoutes, ...contributedRoutes],
		origins: config.origins,
		trustedProxies: config.trustedProxies ?? [],
		cookieSameSite: sessionSettings.sameSite,
		sessionCookieMaximumAgeInSeconds: sessionSettings.cookieMaximumAgeInSeconds,
		// E-233: one window, read from the session settings, so the pipeline and the actor agree.
		freshnessWindowInSeconds: Math.ceil(
			sessionSettings.freshnessWindowMs / MILLISECONDS_IN_A_SECOND,
		),
		callers: callerResolver(sessions, pending, resolutions),
		pluginContextOf: (route) => pluginRuntime.contextOf(route),
		rateLimiter: createRateLimiter({
			driver,
			keys: config.keys,
			schema,
			clock,
			config: { routeFlood: routeFloodWatchOf(rateLimit) },
		}),
		clock,
		log,
	};

	report(log, reportedWeakenings(config, sessionSettings.freshnessWindowMs));

	const readSession = createServerMethod(read, environment);

	const surface = {
		routes: environment.routes,
		identityMode: identity.mode,
		errorCodes: ERROR_CODES,
		http: environment,

		maintenance: { sweep: () => sweepExpiredRows({ driver, schema }) },

		async migrate(): Promise<MigrationReport> {
			const applied = await runMigrations({
				driver,
				schema,
				migrations: coreMigrations(identity.mode),
			});
			await assertKeysAnswerForEveryPurpose(config.keys);
			// E-179: the operator's report, once, loud, and not on the sign-in path.
			await assertStoredKeyVersionsAreKnown({ driver, keys: config.keys, schema });
			return applied;
		},

		/** The connection came from the application and goes back to it; the library never opened one. */
		close: () => Promise.resolve(),

		signOut: createServerMethod(signOut, environment),

		session: {
			resolve: ({ sessionToken, ...call }) => readSession({ ...call, sessionToken }),
			list: createServerMethod(list, environment),
			revoke: createServerMethod(revoke, environment),
			revokeAllOther: createServerMethod(revokeAllOther, environment),
			revokeAll: createServerMethod(revokeAll, environment),
			refresh: createServerMethod(refresh, environment),
		} satisfies SessionNamespace,

		pending: {
			resolve: async (token) => (await pending.resolve(token))?.pending ?? null,
			cancel: ({ pendingToken }) => pending.cancel({ token: pendingToken }),
		} satisfies PendingNamespace,

		user: {
			findById: ({ userId }) => users.findUserById(userId),
			findByEmail: ({ email }) => users.findUserByEmail(email),
			// B.3: `reason` is logged and never stored — 3.14 rules out an audit log.
			disable: async ({ userId, reason }) => {
				log("warn", "account disabled", { userId, reason });
				await users.setDisabledAt({ userId, disabled: true });
			},
			enable: ({ userId }) => users.setDisabledAt({ userId, disabled: false }),
			delete: ({ userId }) => users.deleteUser(userId),
		} satisfies UserNamespace,

		...(usernameTable === null
			? {}
			: {
					username: {
						isAvailable: createServerMethod(usernameTable[0], environment),
					} satisfies UsernameNamespace,
				}),
	};

	return surface as VelveAuth<M>;
}
