import type { ResolvedPendingAuthentication, Session } from "./caller.js";
import { type CookieCollector, type CookieInstruction, createCookieCollector } from "./cookies.js";
import { cookiePolicyOf, type HttpEnvironment, type LogLevel } from "./environment.js";
import { ConcealedError, toVisibleFailure, VelveError } from "./error-map.js";
import { assertOriginAllowed, isSameOriginRead } from "./origin.js";
import type { BucketRule, RateLimitScope } from "./rate-limit.js";
import {
	invocationOf,
	isReadingRoute,
	type RequestContext,
	type RouteMetadata,
	type RunnableRoute,
	readsOAuthStateCookie,
	readsPendingCookie,
} from "./route.js";

interface CallerTokens {
	readonly sessionToken: string | null;
	readonly pendingToken: string | null;
	readonly oauthStateToken: string | null;
}

export interface RouteCall {
	readonly origin: string | null;
	/** the `Sec-Fetch-Site` header, which a server call never carries */
	readonly fetchSite: string | null;
	readonly ipAddress: string | null;
	readonly userAgent: string | null;
	readonly readCallerTokens: () => CallerTokens;
	readonly readInput: () => Promise<unknown>;
}

type DeferredWork = () => Promise<unknown>;

const deferredByContext = new WeakMap<RequestContext, DeferredWork[]>();

//work deferred here starts only after the caller holds its answer (S-TIM-5)
export function deferUntilAnswered(context: RequestContext, work: DeferredWork): void {
	const deferred = deferredByContext.get(context);
	if (deferred === undefined) {
		throw new Error("Deferred work needs a request context the pipeline created");
	}
	deferred.push(work);
}

//a macrotask runs only once every continuation that hands the answer back has run
function startAfterAnswer(
	deferred: readonly DeferredWork[],
	routeName: string,
	environment: HttpEnvironment,
): void {
	if (deferred.length === 0) {
		return;
	}
	setTimeout(() => {
		for (const work of deferred) {
			//a failure here is logged for the operator and never reaches the caller
			work().catch(() => write(environment, "warn", "deferred work failed", { route: routeName }));
		}
	}, 0);
}

export interface RouteOutcome<Output> {
	readonly output: Output;
	readonly cookies: readonly CookieInstruction[];
}

async function consumeBucket(
	environment: HttpEnvironment,
	routeName: string,
	rule: BucketRule,
	scope: RateLimitScope,
): Promise<void> {
	const decision = await environment.rateLimiter.consume({ routeName, rule, scope });
	if (decision.allowed) {
		return;
	}
	throw decision.retryAfterSeconds === undefined
		? new VelveError("rate_limited")
		: new VelveError("rate_limited", { retryAfterSeconds: decision.retryAfterSeconds });
}

async function resolveSession(
	sessionToken: string | null,
	environment: HttpEnvironment,
): Promise<Session> {
	if (sessionToken === null) {
		throw new ConcealedError("cookie_absent");
	}
	return environment.callers.resolveSession(sessionToken);
}

async function resolvePending(
	pendingToken: string | null,
	environment: HttpEnvironment,
): Promise<ResolvedPendingAuthentication> {
	if (pendingToken === null) {
		throw new ConcealedError("pending_cookie_absent");
	}
	return environment.callers.resolvePending(pendingToken);
}

function assertSessionIsFresh(session: Session, environment: HttpEnvironment): void {
	const ageInSeconds = (environment.clock.now().getTime() - session.createdAt.getTime()) / 1000;
	if (ageInSeconds >= environment.freshnessWindowInSeconds) {
		throw new VelveError("freshness_required");
	}
}

interface AccountBucket {
	consume(normalisedIdentifier: string): Promise<void>;
	wasConsumed(): boolean;
}

//the account key is the normalised identifier, formed before the user is resolved (E-116)
function createAccountBucket(route: RouteMetadata, environment: HttpEnvironment): AccountBucket {
	let consumed = false;
	return {
		consume: async (normalisedIdentifier) => {
			consumed = true;
			const rule = route.rateLimit.perAccount;
			if (rule !== "none") {
				await consumeBucket(environment, route.name, rule, {
					kind: "account",
					accountIdentifier: normalisedIdentifier,
				});
			}
		},
		wasConsumed: () => consumed,
	};
}

function warnOnUnconsumedAccountBucket(
	route: RouteMetadata,
	accountBucket: AccountBucket,
	environment: HttpEnvironment,
): void {
	if (route.rateLimit.perAccount !== "none" && !accountBucket.wasConsumed()) {
		write(environment, "warn", "route declares an account rate limit it never consumed", {
			route: route.name,
		});
	}
}

async function createRequestContext(
	route: RouteMetadata,
	call: RouteCall,
	environment: HttpEnvironment,
	cookies: CookieCollector,
	accountBucket: AccountBucket,
	deferred: DeferredWork[],
): Promise<RequestContext> {
	const tokens = call.readCallerTokens();
	//a route that does not declare the cookie readable must see it as absent (S-CACHE-4)
	const pendingToken = readsPendingCookie(route) ? tokens.pendingToken : null;
	const oauthStateToken = readsOAuthStateCookie(route) ? tokens.oauthStateToken : null;
	const session =
		route.caller === "session" ? await resolveSession(tokens.sessionToken, environment) : null;
	if (session !== null && route.freshness === "required") {
		assertSessionIsFresh(session, environment);
	}
	const pending =
		route.caller === "pending" ? await resolvePending(pendingToken, environment) : null;

	const context: RequestContext = {
		session,
		pending,
		sessionToken: tokens.sessionToken,
		pendingToken,
		oauthStateToken,
		ipAddress: call.ipAddress,
		userAgent: call.userAgent,
		cookies,
		plugin: environment.pluginContextOf(route),
		enforceAccountRateLimit: accountBucket.consume,
	};
	deferredByContext.set(context, deferred);
	return context;
}

async function enforceIpAddressRateLimit(
	route: RouteMetadata,
	call: RouteCall,
	environment: HttpEnvironment,
): Promise<void> {
	const rule = route.rateLimit.perIpAddress;
	if (rule !== "none") {
		await consumeBucket(environment, route.name, rule, {
			kind: "ip_address",
			ipAddress: call.ipAddress,
		});
	}
}

//a logger that throws must not cost the caller its answer
function write(
	environment: HttpEnvironment,
	level: LogLevel,
	message: string,
	fields: Readonly<Record<string, unknown>>,
): void {
	try {
		environment.log(level, message, fields);
	} catch {
		return;
	}
}

export function toLoggedFailure(
	cause: unknown,
	routeName: string,
	environment: HttpEnvironment,
): VelveError {
	const failure = toVisibleFailure(cause);
	const fields =
		failure.diagnostic === undefined
			? { route: routeName, reason: failure.loggedReason }
			: { route: routeName, reason: failure.loggedReason, cause: failure.diagnostic };
	write(
		environment,
		failure.error.httpStatus >= 500 ? "error" : "warn",
		"request rejected",
		fields,
	);
	return failure.error;
}

export async function runRoute<Output>(
	route: RunnableRoute<Output>,
	call: RouteCall,
	environment: HttpEnvironment,
): Promise<RouteOutcome<Output>> {
	if (route.originCheck === "checked" && !isSameOriginRead(call, isReadingRoute(route))) {
		assertOriginAllowed(call.origin, environment.origins);
	}
	await enforceIpAddressRateLimit(route, call, environment);

	const cookies = createCookieCollector(cookiePolicyOf(environment));
	const accountBucket = createAccountBucket(route, environment);
	const deferred: DeferredWork[] = [];
	let handlerReached = false;
	const resolveContext = async (): Promise<RequestContext> => {
		const context = await createRequestContext(
			route,
			call,
			environment,
			cookies,
			accountBucket,
			deferred,
		);
		handlerReached = true;
		return context;
	};

	try {
		const output = await invocationOf(route)(await call.readInput(), resolveContext);
		return { output, cookies: cookies.collect() };
	} finally {
		//the account bucket bounds failed attempts, so it is checked after a throw as well
		if (handlerReached) {
			warnOnUnconsumedAccountBucket(route, accountBucket, environment);
		}
		startAfterAnswer(deferred, route.name, environment);
	}
}
