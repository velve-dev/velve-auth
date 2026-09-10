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
import { findUserByIdentifier } from "../identity/resolution.js";
import type { SessionResolution } from "../session/service.js";
import { createPasswordEnvironmentReader, type PasswordEnvironmentReader } from "./environment.js";
import { acceptSubmittedPassword } from "./policy.js";
import { refuseIfCredentialExists, replacePasswordOfSession } from "./set-credential.js";
import { checkPassword, type PasswordEnvironment } from "./verify.js";

export interface SignInPasswordNamespace<M extends IdentityMode> {
	password(input: SignInLookup<M> & { password: string } & ServerCallFields): Promise<SignInResult>;
}

/** The half of 3.15 B.4 that a session carries out on its own account. */
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

/** 3.15 A.1: one lookup field in every mode, and in `username_email` it is resolved by format. */
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

/**
 * S-RATE-7: the counter is keyed before the account is resolved, so a present and an absent
 * identifier advance the same row; the shape is the one the rate-limit suite already assumes.
 */
function accountKeyOf(identifier: string): string {
	return identifier.trim().toLowerCase();
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
	// S-ENUM-6: the true reason is what is raised, and `error-map` is the one place that decides
	// how little of it the caller is told.
	if (check.outcome === "refused") {
		throw new ConcealedError(check.reason);
	}
	if (check.outcome !== "verified") {
		throw new ConcealedError("password_mismatch");
	}
	// S-TIM-5: the rewrite is not awaited, so it cannot lengthen the answer that triggered it.
	void check.rehash?.().catch(() => undefined);
	return check.userId;
}

async function signedIn(
	services: RouteServices,
	context: RequestContext,
	userId: string,
): Promise<SignInResult> {
	// 3.6: a correct password is not a session while the account still offers a second factor.
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

/**
 * The three rows of 3.15 D.3 that a password reaches: the way in, and the two ways a session
 * writes one. The mailed resets are `flows`, and `redeemResetWithRecoveryCode` with them (E-1181).
 */
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
			// S-DOS-2: the length check depends only on the input, so an unusable password costs no
			// database query and no KDF call whether or not the identifier names an account.
			if (acceptSubmittedPassword(input.password, services.password) === null) {
				throw new ConcealedError("password_mismatch");
			}

			const identifier = lookupIn(input);
			await context.enforceAccountRateLimit(accountKeyOf(identifier));

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
			// S-ENUM-2: a disabled account answers a correct password as a wrong one does, and
			// `account_disabled` reaches no sign-in (L-4).
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
			await context.enforceAccountRateLimit(resolved.userId);
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
			await context.enforceAccountRateLimit(resolved.userId);
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
