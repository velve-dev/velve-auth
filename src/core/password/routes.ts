import type { SignInLookup } from "../auth/config.js";
import type { SignInResult } from "../auth/results.js";
import type { RouteServices } from "../auth/routes.js";
import { actorOfResolvedSession } from "../db/actor.js";
import type { IdentityMode } from "../db/migrations/identity-mode.js";
import { observedIn } from "../flows/environment.js";
import type { SetPasswordResult } from "../flows/results.js";
import type { Session } from "../http/caller.js";
import { ConcealedError, VelveError } from "../http/error-map.js";
import { deferUntilAnswered } from "../http/pipeline.js";
import type { RateLimitRule } from "../http/rate-limit.js";
import { defineRoute, type RequestContext, type ServerCallFields } from "../http/route.js";
import { object, string } from "../http/validators.js";
import type { IdentityConfiguration } from "../identity/configuration.js";
import { comparisonFormOf } from "../identity/fold.js";
import { findUserByIdentifier } from "../identity/resolution.js";
import { equalsInConstantTime } from "../keys/constant-time.js";
import { askBeforeSignIn, createSessionUnderHooks, tellAfterSignIn } from "../plugin/sign-in.js";
import { sealedComponentsOf } from "../security-state/read.js";
import {
	type AccountCheck,
	checkAccount,
	checkAccountOrStandIn,
	passwordCredentialOf,
	sealChange,
	secondFactorsOf,
	sessionEpochOf,
} from "../security-state/runtime.js";
import { componentsAfter, SealingRefusedError } from "../security-state/sealing.js";
import type { SessionResolution } from "../session/service.js";
import { createPasswordCredentialRepository, type PasswordCredentialRow } from "./credential.js";
import { createPasswordEnvironmentReader, type PasswordEnvironmentReader } from "./environment.js";
import { storedMemoryCeilingKiB } from "./limits.js";
import { acceptSubmittedPassword } from "./policy.js";
import { CREATED_SCHEME } from "./scheme.js";
import { refuseIfCredentialExists, replacePasswordOfSession } from "./set-credential.js";
import { checkPassword, type PasswordEnvironment, type SealedRehash } from "./verify.js";

type UsableCheck = Extract<AccountCheck, { kind: "usable" }>;

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

//the rehash writes the account's credential under the lock and reseals like any change (E-3385)
function rehashUnderTheLock(
	services: RouteServices,
	environment: PasswordEnvironment,
	userId: string,
	rehash: () => Promise<SealedRehash | null>,
): () => Promise<unknown> {
	return async () => {
		const rewritten = await rehash();
		if (rewritten === null) {
			return false;
		}
		return sealChange(
			services.securityState,
			{ unproven: userId },
			{
				epoch: "keep",
				write: async (tx, read) => {
					//a rehash only replaces the ciphertext the sign-in verified and the read still holds (S-INTEG-4)
					if (
						read.password === null ||
						!equalsInConstantTime(read.password.phc, rewritten.previous)
					) {
						return null;
					}
					const stored = await createPasswordCredentialRepository({
						driver: tx,
						keys: environment.keys,
						schema: services.schema,
						memoryCeilingKiB: storedMemoryCeilingKiB(services.password.argon2id.memoryKiB),
					}).replaceIfUnchanged({
						userId,
						previous: rewritten.previous,
						phc: rewritten.phc,
						scheme: CREATED_SCHEME,
					});
					//a swap that misses under the lock met a credential written past it (E-3166)
					if (stored === null) {
						throw new SealingRefusedError("seal_mismatch");
					}
					return stored;
				},
				after: (read, stored) =>
					stored === null || read.password === null
						? sealedComponentsOf(read)
						: componentsAfter(read, {
								password: {
									...read.password,
									phc: stored.ciphertext,
									keyVersion: stored.keyVersion,
									scheme: CREATED_SCHEME,
								},
							}),
			},
		).catch(() => false);
	};
}

async function verifiedAccount(
	services: RouteServices,
	environment: PasswordEnvironment,
	context: RequestContext,
	input: {
		readonly userId: string | null;
		readonly plaintext: string;
		readonly checked: PasswordCredentialRow | null;
	},
): Promise<string> {
	const check = await checkPassword(input, environment);
	//the true reason is raised and only error-map decides what the caller learns (S-ENUM-6)
	if (check.outcome === "refused") {
		throw new ConcealedError(check.reason);
	}
	if (check.outcome !== "verified") {
		throw new ConcealedError("password_mismatch");
	}
	if (check.rehash !== undefined) {
		deferUntilAnswered(
			context,
			rehashUnderTheLock(services, environment, check.userId, check.rehash),
		);
	}
	return check.userId;
}

//a broken account must cost a password sign-in what a wrong password costs (S-INTEG-5)
async function checkedCredential(
	services: RouteServices,
	userId: string | null,
	identifier: string,
): Promise<{ readonly check: AccountCheck; readonly checked: PasswordCredentialRow | null }> {
	const check = await checkAccountOrStandIn(services.securityState, userId, identifier);
	return {
		check,
		checked:
			check.kind === "usable" ? passwordCredentialOf(services.securityState, check.read) : null,
	};
}

async function signedIn(
	services: RouteServices,
	context: RequestContext,
	userId: string,
	check: UsableCheck,
): Promise<SignInResult> {
	//a correct password is no session while the account still offers a second factor (S-FIX-4)
	const begun = await services.pending.begin({
		userId,
		factorsCompleted: ["password"],
		sessionEpoch: sessionEpochOf(check),
		offered: {
			factors: secondFactorsOf(check.read),
			refusal: "broken_state_on_password_sign_in",
		},
	});
	if (begun.pending.availableFactors.length > 0) {
		context.cookies.setPending(begun.token);
		return { status: "second_factor_required", pendingToken: begun.token, pending: begun.pending };
	}

	await services.pending.consume(begun.token);
	const observed = observedIn(context);
	const hooks = services.pluginRuntime.hooks;
	const issued = await createSessionUnderHooks(hooks, { userId, factors: ["password"] }, () =>
		services.sessions.issueReplacingPresented({
			completes: "password_sign_in",
			authorisedBy: check.authorisedBy,
			presentedToken: context.sessionToken,
			userId,
			factors: ["password"],
			observed,
		}),
	);
	const user = await services.users.findUserById(userId);
	if (user === null) {
		throw new ConcealedError("user_not_found");
	}
	await tellAfterSignIn(hooks, { method: "password", observed, session: issued.session });
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
			await askBeforeSignIn(services.pluginRuntime.hooks, "password", observedIn(context));

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
			const { check, checked } = await checkedCredential(
				services,
				found === null ? null : found.id,
				identifier,
			);
			const userId = await verifiedAccount(services, environment, context, {
				userId: found === null ? null : found.id,
				plaintext: input.password,
				checked,
			});
			//a broken state is told only by the alarm and answers like a wrong password (S-INTEG-5)
			if (check.kind !== "usable") {
				throw new ConcealedError("password_mismatch");
			}
			//a disabled account answers a correct password like a wrong one (S-ENUM-2)
			if (check.read.disabled) {
				throw new ConcealedError("user_disabled_on_sign_in");
			}
			return signedIn(services, context, userId, check);
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
			await refuseIfCredentialExists(environment, actorOfResolvedSession(resolved));
			return replacePasswordOfSession(services, environment, context, {
				completes: "password_set",
				resolved,
				newPassword: input.newPassword,
				checkedPhc: null,
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
			const check = await checkAccount(services.securityState, resolved.userId, "change");
			const checked =
				check.kind === "usable" ? passwordCredentialOf(services.securityState, check.read) : null;
			await verifiedAccount(services, environment, context, {
				userId: resolved.userId,
				plaintext: input.currentPassword,
				checked,
			});
			if (checked === null) {
				throw new ConcealedError("password_mismatch");
			}
			return replacePasswordOfSession(services, environment, context, {
				completes: "password_change",
				resolved,
				newPassword: input.newPassword,
				checkedPhc: checked.phc,
			});
		},
	});

	return [signIn, set, change] as const;
}
