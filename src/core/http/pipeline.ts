import type { PendingAuthentication, Session } from "./caller.js";
import { type CookieCollector, type CookieInstruction, createCookieCollector } from "./cookies.js";
import { cookiePolicyOf, type HttpEnvironment } from "./environment.js";
import { ConcealedError, VelveError } from "./error-map.js";
import { assertOriginAllowed } from "./origin.js";
import type { BucketRule, RateLimitScope } from "./rate-limit.js";
import type { RequestContext, RouteRuntime } from "./route.js";

interface CallerTokens {
	readonly sessionToken: string | null;
	readonly pendingToken: string | null;
}

export interface RouteCall {
	readonly origin: string | null;
	readonly ipAddress: string | null;
	readonly userAgent: string | null;
	readonly readCallerTokens: () => CallerTokens;
	readonly readInput: () => Promise<unknown>;
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
): Promise<PendingAuthentication> {
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

async function createRequestContext(
	route: RouteRuntime<unknown>,
	call: RouteCall,
	environment: HttpEnvironment,
	cookies: CookieCollector,
): Promise<RequestContext> {
	const tokens = call.readCallerTokens();
	const session =
		route.caller === "session" ? await resolveSession(tokens.sessionToken, environment) : null;
	if (session !== null && route.freshness === "required") {
		assertSessionIsFresh(session, environment);
	}
	const pending =
		route.caller === "pending" ? await resolvePending(tokens.pendingToken, environment) : null;

	return {
		session,
		pending,
		sessionToken: tokens.sessionToken,
		ipAddress: call.ipAddress,
		userAgent: call.userAgent,
		cookies,
		enforceAccountRateLimit: async (accountIdentifier) => {
			const rule = route.rateLimit.perAccount;
			if (rule !== "none") {
				await consumeBucket(environment, route.name, rule, {
					kind: "account",
					accountIdentifier,
				});
			}
		},
	};
}

async function enforceIpAddressRateLimit(
	route: RouteRuntime<unknown>,
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

export async function runRoute<Output>(
	route: RouteRuntime<Output>,
	call: RouteCall,
	environment: HttpEnvironment,
): Promise<RouteOutcome<Output>> {
	if (route.originCheck === "checked") {
		assertOriginAllowed(call.origin, environment.origins);
	}
	await enforceIpAddressRateLimit(route, call, environment);

	const cookies = createCookieCollector(cookiePolicyOf(environment));
	const output = await route.invoke(await call.readInput(), () =>
		createRequestContext(route, call, environment, cookies),
	);

	return { output, cookies: cookies.collect() };
}
