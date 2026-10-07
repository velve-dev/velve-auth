import type { Driver } from "../db/driver.js";
import type { MigrationReport } from "../db/migration.js";
import { runMigrations } from "../db/migration-runner.js";
import type { IdentityMode } from "../db/migrations/identity-mode.js";
import { coreMigrations } from "../db/migrations/index.js";
import { withReadCommittedTransactions } from "../db/read-committed.js";
import { createSessionRepository } from "../db/repositories/session.js";
import { createOneTimeTokenRepository } from "../db/repositories/token.js";
import {
	createPendingAuthenticationService,
	createSecondFactorCompletion,
	type PendingAuthenticationService,
	type PendingToken,
	toPendingToken,
} from "../factor/pending/index.js";
import { type FactorSurface, factorRoutes } from "../factor/routes.js";
import { assertStoredFactorKeyVersionsAreKnown } from "../factor/startup.js";
import { type EmailFlowSurface, emailFlowRoutes } from "../flows/routes.js";
import type { CallerResolver, PendingAuthentication, Session } from "../http/caller.js";
import { readCookies } from "../http/cookies.js";
import { type Clock, cookiePolicyOf, type HttpEnvironment } from "../http/environment.js";
import {
	ConcealedError,
	registerDeclaredPluginErrorCodes,
	VELVE_ERROR_CODES,
	type VelveErrorCode,
} from "../http/error-map.js";
import { toLoggedFailure } from "../http/pipeline.js";
import {
	type AnyRoute,
	classifyCoreReadingRoutes,
	type RouteMetadata,
	type ServerCallFields,
} from "../http/route.js";
import { createServerMethod } from "../http/server-method.js";
import { resolveIdentityConfiguration } from "../identity/configuration.js";
import { comparisonFormOf } from "../identity/fold.js";
import { createRateLimiter } from "../limit/index.js";
import { type OAuthSurface, oauthRoutes } from "../oauth/routes.js";
import { resolvePasswordConfig } from "../password/config.js";
import { type PasswordSurface, passwordRoutes } from "../password/routes.js";
import { createKdfSemaphore } from "../password/semaphore.js";
import { assertStoredKeyVersionsAreKnown } from "../password/startup.js";
import type { VelvePlugin } from "../plugin/config.js";
import type { FrozenContextServices } from "../plugin/context.js";
import {
	assertPluginDatabaseRole,
	grantOwnTablesToThePluginRole,
} from "../plugin/database-role.js";
import { createPluginConnection } from "../plugin/login-connection.js";
import { pluginMigrations } from "../plugin/migrations.js";
import { assertNoCoreRouteIsOverwritten, createPluginRuntime } from "../plugin/registry.js";
import { type PluginSurface, pluginRoutes } from "../plugin/routes.js";
import { type SessionSettings, sessionSettingsOf } from "../session/config.js";
import { createSessionService, type SessionService } from "../session/service.js";
import { createOneTimeTokens } from "../token/one-time-token.js";
import type { ModeHasUsername, RateLimitConfig, VelveAuthConfig } from "./config.js";
import { assertStoredIntegrityKeysTakeMac } from "./integrity-key-ring.js";
import { type SweepReport, sweepExpiredRows } from "./maintenance.js";
import { rateLimitConfigOf, routeAlarmReportedTo, routeFloodWatchOf } from "./rate-limiting.js";
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
import {
	assertConfigurationIsStartable,
	assertKeysAnswerForEveryPurpose,
	type RouteConflict,
	THE_CORE,
	VelveStartupError,
} from "./startup.js";
import { assertNoStatedNameShadowsADerivedOne, nestServerMethods } from "./surface.js";
import { createUserRepository, type User, type UserRepository } from "./user.js";

const DEFAULT_SCHEMA = "velve";
const MILLISECONDS_IN_A_SECOND = 1000;

const NO_SINK: HttpEnvironment["log"] = () => undefined;

const ERROR_CODES = VELVE_ERROR_CODES;

export interface SessionNamespace {
	resolve(input: { sessionToken: string } & ServerCallFields): Promise<ResolvedSessionView | null>;
	resolveFromHeaders(headers: Headers): Promise<ResolvedSessionView | null>;
	list(input: ServerCallFields): Promise<Session[]>;
	revoke(input: { targetSessionId: string } & ServerCallFields): Promise<void>;
	revokeAllOther(input: ServerCallFields): Promise<{ revokedCount: number }>;
	revokeAll(input: ServerCallFields): Promise<{ revokedCount: number }>;
	refresh(input: ServerCallFields): Promise<ResolvedSessionView | null>;
}

/** the intermediate state names the factors still open and never any user data */
export interface PendingNamespace {
	resolve(token: PendingToken): Promise<PendingAuthentication | null>;
	resolveFromHeaders(headers: Headers): Promise<PendingAuthentication | null>;
	cancel(input: { pendingToken: PendingToken } & ServerCallFields): Promise<void>;
}

/** the methods of the user namespace that every identity mode carries */
interface UserNamespaceInEveryMode {
	findById(input: { userId: string }): Promise<User | null>;
	disable(input: { userId: string; reason: string }): Promise<void>;
	enable(input: { userId: string }): Promise<void>;
	delete(input: { userId: string }): Promise<void>;
}

/** what the application calls in its own process after its own authorization decision */
export interface UserNamespace extends UserNamespaceInEveryMode {
	findByEmail(input: { email: string }): Promise<User | null>;
}

/** the lookup by name, offered in the two modes that have a username */
interface UserNamespaceWithUsernames extends UserNamespace {
	findByUsername(input: { username: string }): Promise<User | null>;
}

/** mode `username` finds an account by name and has no lookup by address */
interface UserNamespaceInUsernameMode extends UserNamespaceInEveryMode {
	findByUsername(input: { username: string }): Promise<User | null>;
}

type UserNamespaceOf<M extends IdentityMode> = M extends "email"
	? UserNamespace
	: M extends "username"
		? UserNamespaceInUsernameMode
		: UserNamespaceWithUsernames;

export interface UsernameNamespace {
	isAvailable(input: { username: string } & ServerCallFields): Promise<UsernameAvailabilityAnswer>;
	change(input: { newUsername: string } & ServerCallFields): Promise<{ readonly user: User }>;
}

export interface AuthInternals {
	readonly routes: readonly AnyRoute[];
	readonly identityMode: IdentityMode;
	readonly errorCodes: readonly VelveErrorCode[];
	readonly maintenance: { sweep(): Promise<SweepReport> };
	/** the one asynchronous start step, and where the key ring report runs */
	migrate(): Promise<MigrationReport>;
	close(): Promise<void>;
	/** the HTTP environment `toWebHandler` reads from the instance */
	readonly http: HttpEnvironment;
	/** every option the start reported as weaker than its default, in the shape it was reported */
	readonly weakenings: readonly ChosenWeakening[];
}

/** what each feature's own seam module contributes to the surface, joined into one type */
type SeamSurface<M extends IdentityMode> = OAuthSurface<M> &
	EmailFlowSurface<M> &
	PasswordSurface<M> &
	PluginSurface<M> &
	FactorSurface;

export type VelveAuth<M extends IdentityMode> = AuthInternals &
	SeamSurface<M> & {
		signOut(input: ServerCallFields): Promise<void>;
		readonly session: SessionNamespace;
		readonly pending: PendingNamespace;
		readonly user: UserNamespaceOf<M>;
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

		//only the four routes with caller pending may resolve a pending token (S-CACHE-4)
		async resolvePending(pendingToken) {
			const resolved = await pending.resolve(pendingToken as PendingToken);
			if (resolved === null) {
				throw new ConcealedError("pending_not_found");
			}
			return resolved;
		},
	};
}

//this states the specification and not the build, so an unbuilt namespace stays core (E-779)
export const SURFACE_NAMESPACES: readonly string[] = [
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
	"weakenings",
];

//a plugin taking a core namespace must be a start error, keyed by the route's name (E-780)
function assertNoPluginTakesACoreNamespace(
	plugins: readonly VelvePlugin[],
	contributed: readonly AnyRoute[],
	ownerOf: (route: RouteMetadata) => string,
): void {
	const reserved = new Set(SURFACE_NAMESPACES);
	const claims: readonly (readonly [string, string])[] = [
		...plugins.map((plugin) => [plugin.id, plugin.id] as const),
		...contributed.map((route) => [route.name.split(".")[0] ?? "", ownerOf(route)] as const),
	];
	for (const [namespace, claimant] of claims) {
		if (reserved.has(namespace)) {
			const conflict: RouteConflict = {
				claimed: namespace,
				contributors: [THE_CORE, claimant],
			};
			throw new VelveStartupError("plugin_route_conflict", conflict);
		}
	}
}

function reportedWeakenings<M extends IdentityMode>(
	config: VelveAuthConfig<M>,
	chosen: { readonly session: SessionSettings; readonly rateLimit: RateLimitConfig },
): readonly ChosenWeakening[] {
	const weakenings = weakeningsIn(config, {
		session: { defaults: sessionSettingsOf(), chosen: chosen.session },
		rateLimit: { defaults: rateLimitConfigOf(), chosen: chosen.rateLimit },
	});
	return Object.freeze(weakenings.map((weakening) => Object.freeze({ ...weakening })));
}

//a sink that throws on one weakening must not cost the others their line nor the start (E-2676)
function report(log: HttpEnvironment["log"], weakenings: readonly ChosenWeakening[]): void {
	for (const weakening of weakenings) {
		try {
			log("warn", "a security option is weaker than its default", { ...weakening });
		} catch {}
	}
}

//an option nobody configured must reach RouteServices as an absent key (E-1258)
function optionalConfigurationOf<M extends IdentityMode>(config: VelveAuthConfig<M>) {
	return {
		...(config.oauth === undefined ? {} : { oauth: config.oauth }),
		...(config.fetch === undefined ? {} : { fetch: config.fetch }),
		...(config.email === undefined ? {} : { email: config.email }),
		...(config.webauthn === undefined ? {} : { webauthn: config.webauthn }),
		...(config.totp === undefined ? {} : { totp: config.totp }),
		...(config.recoveryCodes === undefined ? {} : { recoveryCodes: config.recoveryCodes }),
	};
}

//session options nobody configured must also reach the completion as absent keys (E-1258)
function sessionOptionsOf<M extends IdentityMode>(config: VelveAuthConfig<M>) {
	return {
		...(config.session === undefined ? {} : { session: config.session }),
		...(config.sessionMetadata === undefined ? {} : { sessionMetadata: config.sessionMetadata }),
	};
}

function cookiesIn(headers: Headers, environment: HttpEnvironment) {
	return readCookies(headers.get("cookie"), cookiePolicyOf(environment).names);
}

async function sessionViewOf(
	sessions: SessionService,
	users: UserRepository,
	sessionToken: string,
): Promise<ResolvedSessionView | null> {
	const resolved = await sessions.resolve(sessionToken);
	if (resolved === null) {
		return null;
	}
	const user = await users.findUserById(resolved.userId);
	return user === null ? null : { session: resolved.session, user };
}

//what a caller learns from a method without a route is decided by the same map (E-2832)
async function failuresMappedAs<Output>(
	methodName: string,
	environment: HttpEnvironment,
	resolve: () => Promise<Output>,
): Promise<Output> {
	try {
		return await resolve();
	} catch (cause) {
		throw toLoggedFailure(cause, methodName, environment);
	}
}

//the core reads no clock of its own, so the caller brings the fallback one (E-231)
export function assembleVelveAuth<M extends IdentityMode>(
	config: VelveAuthConfig<M>,
	defaultClock: Clock,
	fallbackWarningSink: HttpEnvironment["log"],
): VelveAuth<M> {
	assertConfigurationIsStartable(config);

	const driver: Driver = withReadCommittedTransactions(config.database);
	const schema = config.schema ?? DEFAULT_SCHEMA;
	const clock = config.clock ?? defaultClock;
	const log = config.log ?? NO_SINK;
	const identity = resolveIdentityConfiguration<M>(config.identity);
	//parameters below the floor must be refused at the start, not at the first hash (S-DEFAULT-6)
	const password = resolvePasswordConfig(config.password);
	const sessionSettings = sessionSettingsOf(config.session);
	//a weakening and a route alarm must reach the operator even without a configured sink (E-2671)
	const operatorWarnings = config.log ?? fallbackWarningSink;
	const rateLimit = rateLimitConfigOf(config.rateLimit, routeAlarmReportedTo(operatorWarnings));

	const sessions = createSessionService({ driver, schema, ...sessionOptionsOf(config) });
	const pending = createPendingAuthenticationService({ driver, schema });
	const users = createUserRepository({ driver, schema });
	const resolutions: ResolutionMemo = new WeakMap();

	const oneTimeTokens = createOneTimeTokens(createOneTimeTokenRepository({ driver, schema }));

	const pluginDatabaseRole =
		config.pluginDatabaseRole === undefined
			? undefined
			: assertPluginDatabaseRole(config.pluginDatabaseRole);
	const pluginConnection =
		config.pluginDatabase === undefined
			? undefined
			: createPluginConnection({ driver: config.pluginDatabase, schema, clock });
	const frozenContextServices: FrozenContextServices = {
		clock,
		identityMode: identity.mode,
		schema,
		users,
		sessions: createSessionRepository({ driver, schema }),
		driver,
		log,
		...(pluginDatabaseRole === undefined ? {} : { pluginDatabaseRole }),
		...(pluginConnection === undefined ? {} : { pluginConnection }),
	};
	//every plugin hook runs from a handler, which runs after the origin check (S-CSRF-6)
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
		kdfSemaphore: createKdfSemaphore({ limit: password.concurrentHashLimit }),
		origins: config.origins,
		completeSecondFactor: createSecondFactorCompletion({
			driver,
			schema,
			...sessionOptionsOf(config),
		}),
		...optionalConfigurationOf(config),
		pluginRuntime,
	};

	const [signOut, read, list, revoke, revokeAllOther, revokeAll, refresh] = sessionRoutes(services);
	const pendingTable = pendingRoutes(services);
	const [, cancelPending] = pendingTable;
	const usernameTable =
		identity.mode === "email" ? null : usernameRoutes(services, identity.username);

	const seamRoutes: readonly AnyRoute[] = [
		...oauthRoutes(services),
		...emailFlowRoutes(services),
		...passwordRoutes(services),
		...factorRoutes(services),
	];
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
		...seamRoutes,
	];
	classifyCoreReadingRoutes(coreRoutes);
	const contributedRoutes = pluginRoutes(services);
	const ownerOfRoute = (route: RouteMetadata): string => pluginRuntime.ownerOf(route);
	assertNoCoreRouteIsOverwritten(contributedRoutes, coreRoutes, ownerOfRoute);
	assertNoPluginTakesACoreNamespace(pluginRuntime.plugins, contributedRoutes, ownerOfRoute);

	const environment: HttpEnvironment = {
		routes: [...coreRoutes, ...contributedRoutes],
		origins: config.origins,
		trustedProxies: config.trustedProxies ?? [],
		sessionCookieName: sessionSettings.cookieName,
		cookieSameSite: sessionSettings.sameSite,
		sessionCookieMaximumAgeInSeconds: sessionSettings.cookieMaximumAgeInSeconds,
		//one freshness window keeps the pipeline and the actor in agreement (E-233)
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

	const weakenings = reportedWeakenings(config, { session: sessionSettings, rateLimit });
	report(operatorWarnings, weakenings);

	const readSession = createServerMethod(read, environment);

	const derivedSurface = nestServerMethods(seamRoutes, environment);

	const statedSurface = {
		routes: environment.routes,
		identityMode: identity.mode,
		errorCodes: ERROR_CODES,
		http: environment,
		weakenings,

		maintenance: { sweep: () => sweepExpiredRows({ driver, schema }) },

		async migrate(): Promise<MigrationReport> {
			const applied = await runMigrations({
				driver,
				schema,
				//the plugin seam contributes here, so no feature edits this file to be run (E-776)
				migrations: [...coreMigrations(identity.mode), ...pluginMigrations(services)],
			});
			//the plugin login is checked against the core tables this run just applied (E-2641)
			const pluginRole =
				pluginConnection === undefined
					? pluginDatabaseRole
					: await pluginConnection.verifyFrom(driver);
			if (pluginRole !== undefined) {
				await grantOwnTablesToThePluginRole({
					driver,
					schema,
					role: pluginRole,
					migrations: pluginMigrations(services),
				});
			}
			await assertKeysAnswerForEveryPurpose(config.keys);
			await assertStoredIntegrityKeysTakeMac({ driver, keys: config.keys, schema });
			//a dead key version is reported once at startup and not on the sign-in path (E-179)
			await assertStoredKeyVersionsAreKnown({ driver, keys: config.keys, schema });
			//totp-enc and token-pepper hide a dead key version harder and need the same report (E-428)
			await assertStoredFactorKeyVersionsAreKnown({ driver, keys: config.keys, schema });
			return applied;
		},

		//the connection belongs to the application and the library never opened one
		close: () => Promise.resolve(),

		signOut: createServerMethod(signOut, environment),

		session: {
			resolve: ({ sessionToken, ...call }) => readSession({ ...call, sessionToken }),
			resolveFromHeaders: (headers) =>
				failuresMappedAs("session.resolveFromHeaders", environment, async () => {
					const sessionToken = cookiesIn(headers, environment).session;
					return sessionToken === null ? null : sessionViewOf(sessions, users, sessionToken);
				}),
			list: createServerMethod(list, environment),
			revoke: createServerMethod(revoke, environment),
			revokeAllOther: createServerMethod(revokeAllOther, environment),
			revokeAll: createServerMethod(revokeAll, environment),
			refresh: createServerMethod(refresh, environment),
		} satisfies SessionNamespace,

		pending: {
			resolve: async (token) => (await pending.resolve(token))?.pending ?? null,
			resolveFromHeaders: (headers) =>
				failuresMappedAs("pending.resolveFromHeaders", environment, async () => {
					const pendingToken = cookiesIn(headers, environment).pending;
					return pendingToken === null
						? null
						: ((await pending.resolve(toPendingToken(pendingToken)))?.pending ?? null);
				}),
			//the direct call must meet the origin check and the bucket the route declares (E-2830)
			cancel: createServerMethod(cancelPending, environment),
		} satisfies PendingNamespace,

		user: {
			findById: ({ userId }) => users.findUserById(userId),
			//the reason is logged and never stored, as the library keeps no audit log (E-37)
			disable: async ({ userId, reason }) => {
				log("warn", "account disabled", { userId, reason });
				await users.setDisabledAt({ userId, disabled: true });
			},
			enable: ({ userId }) => users.setDisabledAt({ userId, disabled: false }),
			delete: ({ userId }) => users.deleteUser(userId),
			...(identity.mode === "username"
				? {}
				: {
						//mode username has no lookup by address (E-3022)
						findByEmail: ({ email }: { email: string }) => users.findUserByEmail(email),
					}),
			...(identity.mode === "email"
				? {}
				: {
						//an account is found by the comparison form whatever the rules accept today (E-2833)
						findByUsername: ({ username }: { username: string }) =>
							users.findUserByUsernameKey(comparisonFormOf(username)),
					}),
		} satisfies UserNamespaceInEveryMode,

		...(usernameTable === null
			? {}
			: {
					username: {
						isAvailable: createServerMethod(usernameTable[0], environment),
						change: createServerMethod(usernameTable[1], environment),
					} satisfies UsernameNamespace,
				}),
	};

	//a stated name must not replace a derived namespace whole (E-1192)
	assertNoStatedNameShadowsADerivedOne(derivedSurface, statedSurface);
	const coreSurface = { ...derivedSurface, ...statedSurface };

	const surface = { ...nestServerMethods(contributedRoutes, environment), ...coreSurface };
	//this must stay last, as a refusal above must leave nothing of a plugin behind (E-665)
	registerDeclaredPluginErrorCodes(pluginRuntime.declaredErrorCodes);
	return surface as VelveAuth<M>;
}
