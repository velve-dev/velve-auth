import type { SignInLookup } from "../auth/config.js";
import type { SignInResult } from "../auth/results.js";
import type { RouteServices } from "../auth/routes.js";
import type { IdentityMode } from "../db/migrations/identity-mode.js";
import { observedIn } from "../flows/environment.js";
import type { SetPasswordResult } from "../flows/results.js";
import type { Session } from "../http/caller.js";
import { ConcealedError, VelveError } from "../http/error-map.js";
import type { RateLimitRule } from "../http/rate-limit.js";
import { defineRoute, type RequestContext, type ServerCallFields } from "../http/route.js";
import { object, string } from "../http/validators.js";
import type { IdentityConfiguration } from "../identity/configuration.js";
import { comparisonFormOf } from "../identity/fold.js";
import { findUserByIdentifier } from "../identity/resolution.js";
import type { SessionResolution } from "../session/service.js";
import { createPasswordEnvironmentReader, type PasswordEnvironmentReader } from "./environment.js";
import { acceptSubmittedPassword } from "./policy.js";
import { refuseIfCredentialExists, replacePasswordOfSession } from "./set-credential.js";
import { checkPassword, type PasswordEnvironment } from "./verify.js";

export interface SignInPasswordNamespace<M extends IdentityMode> {
	password(input: SignInLookup<M> & { password: string } & ServerCallFields): Promise<SignInResult>;
}

/** setting and changing the PHC credential of the signed-in account */
export interface SetPasswordNamespace {
	set(input: { newPassword: string } & ServerCallFields): Promise<SetPasswordResult>;
	change(
		input: { currentPassword: string; newPassword: string } & ServerCallFields,
	): Promise<SetPasswordResult>;
}

export type PasswordSurface<M extends IdentityMode> = {
	readonly signIn: SignInPasswordNamespace<M>;
	readonly password: SetPasswordNamespace;
};

function signInLookupOf(identity: IdentityConfiguration) {
	return identity.mode === "email"
		? { email: string() }
		: identity.mode === "username"
			? { username: string() }
			: { emailOrUsername: string() };
}

interface SubmittedLookup {
	readonly email?: string | undefined;
	readonly username?: string | undefined;
	readonly emailOrUsername?: string | undefined;
}

function lookupIn(input: SubmittedLookup): string {
	return input.emailOrUsername ?? input.email ?? input.username ?? "";
}

//the counter uses the comparison form so two spellings cannot advance two rows (E-1194)
async function accountKeyOfSession(services: RouteServices, userId: string): Promise<string> {
	const user = await services.users.findUserById(userId);
	return comparisonFormOf(user?.email ?? user?.username ?? userId);
}

function addressAndAccount(services: RouteServices): RateLimitRule {
	return {
		perIpAddress: services.rateLimit.perIpAddress,
		perAccount: services.rateLimit.perAccount,
	};
}

function requireSessionResolution(
	services: RouteServices,
	session: Session | null,
): SessionResolution {
	if (session === null) {
		throw new ConcealedError("cookie_absent");
	}
	const resolved = services.resolutions.get(session);
	if (resolved === undefined) {
		throw new VelveError("internal_error");
	}
	return resolved;
}

async function verifiedAccount(
	environment: PasswordEnvironment,
	input: { readonly userId: string | null; readonly plaintext: string },
): Promise<string> {
	const check = await checkPassword(input, environment);
	//the true reason is raised and only error-map decides what the caller learns (S-ENUM-6)
	if (check.outcome === "refused") {
		throw new ConcealedError(check.reason);
	}
	if (check.outcome !== "verified") {
		throw new ConcealedError("password_mismatch");
	}
	//the rewrite is not awaited so it never lengthens the answer (S-TIM-5)
	void check.rehash?.().catch(() => undefined);
	return check.userId;
}

async function signedIn(
	services: RouteServices,
	context: RequestContext,
	userId: string,
): Promise<SignInResult> {
	//a correct password is no session while the account still offers a second factor (S-FIX-4)
	const begun = await services.pending.begin({ userId, factorsCompleted: ["password"] });
	if (begun.pending.availableFactors.length > 0) {
		context.cookies.setPending(begun.token);
		return { status: "second_factor_required", pendingToken: begun.token, pending: begun.pending };
	}

	await services.pending.consume(begun.token);
	const issued = await services.sessions.issue({
		userId,
		factors: ["password"],
		observed: observedIn(context),
	});
	const user = await services.users.findUserById(userId);
	if (user === null) {
		throw new ConcealedError("user_not_found");
	}
	context.cookies.setSession(issued.token);
	return { status: "signed_in", sessionToken: issued.token, session: issued.session, user };
}

/** the password routes, signing in and the two ways a session writes its PHC credential */
export function passwordRoutes(services: RouteServices) {
	const readEnvironment: PasswordEnvironmentReader = createPasswordEnvironmentReader(services);

	const signIn = defineRoute({
		name: "signIn.password",
		method: "POST",
		path: "/sign-in/password",
		input: object({ ...signInLookupOf(services.identity), password: string() }),
		errors: ["invalid_input", "invalid_credentials", "rate_limited", "origin_not_allowed"] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressAndAccount(services),
		handler: async (input, context): Promise<SignInResult> => {
			const identifier = lookupIn(input);
			//the rate limit token is spent first so even the cheapest attempt costs something (E-1196)
			await context.enforceAccountRateLimit(comparisonFormOf(identifier));

			//an unusable password resolves no account and runs no KDF either way (S-DOS-2)
			if (acceptSubmittedPassword(input.password, services.password) === null) {
				throw new ConcealedError("password_mismatch");
			}

			const environment = await readEnvironment();
			const found = await findUserByIdentifier({
				driver: services.driver,
				schema: services.schema,
				configuration: services.identity,
				identifier,
			});
			const userId = await verifiedAccount(environment, {
				userId: found === null ? null : found.id,
				plaintext: input.password,
			});
			//a disabled account answers a correct password like a wrong one (S-ENUM-2)
			if (found?.disabled) {
				throw new ConcealedError("user_disabled_on_sign_in");
			}
			return signedIn(services, context, userId);
		},
	});

	const set = defineRoute({
		name: "password.set",
		method: "POST",
		path: "/password/set",
		input: object({ newPassword: string() }),
		errors: [
			"invalid_input",
			"session_required",
			"freshness_required",
			"account_disabled",
			"password_unacceptable",
			"factor_already_enrolled",
			"rate_limited",
			"origin_not_allowed",
		] as const,
		caller: "session",
		freshness: "required",
		originCheck: "checked",
		rateLimit: addressAndAccount(services),
		handler: async (input, context): Promise<SetPasswordResult> => {
			const resolved = requireSessionResolution(services, context.session);
			await context.enforceAccountRateLimit(await accountKeyOfSession(services, resolved.userId));
			const environment = await readEnvironment();
			await refuseIfCredentialExists(environment, resolved.userId);
			return replacePasswordOfSession(services, environment, context, {
				resolved,
				newPassword: input.newPassword,
			});
		},
	});

	const change = defineRoute({
		name: "password.change",
		method: "POST",
		path: "/password/change",
		input: object({ currentPassword: string(), newPassword: string() }),
		errors: [
			"invalid_input",
			"session_required",
			"freshness_required",
			"account_disabled",
			"invalid_credentials",
			"password_unacceptable",
			"rate_limited",
			"origin_not_allowed",
		] as const,
		caller: "session",
		freshness: "required",
		originCheck: "checked",
		rateLimit: addressAndAccount(services),
		handler: async (input, context): Promise<SetPasswordResult> => {
			const resolved = requireSessionResolution(services, context.session);
			await context.enforceAccountRateLimit(await accountKeyOfSession(services, resolved.userId));
			const environment = await readEnvironment();
			await verifiedAccount(environment, {
				userId: resolved.userId,
				plaintext: input.currentPassword,
			});
			return replacePasswordOfSession(services, environment, context, {
				resolved,
				newPassword: input.newPassword,
			});
		},
	});

	return [signIn, set, change] as const;
}
