import type { EmailConfig } from "../auth/config.js";
import type { SignInResult, SignUpResult } from "../auth/results.js";
import type { RouteServices } from "../auth/routes.js";
import type { IdentityMode } from "../db/migrations/identity-mode.js";
import { ConcealedError } from "../http/error-map.js";
import type { RateLimitRule } from "../http/rate-limit.js";
import { type AnyRoute, defineRoute, type RequestContext } from "../http/route.js";
import { object, string } from "../http/validators.js";
import type { IdentityConfiguration } from "../identity/configuration.js";
import { redeemChange, redeemVerification, requestChange, requestVerification } from "./address.js";
import type { FlowEnvironment } from "./environment.js";
import { redeemMagicLink, requestMagicLink } from "./magic-link.js";
import { redeemReset, redeemResetWithRecoveryCode, requestReset } from "./reset.js";
import type {
	ChangedUser,
	EmailNamespace,
	MagicLinkNamespace,
	MailedPasswordNamespace,
	RecoveryPasswordNamespace,
	SetPasswordResult,
	SignUpNamespace,
} from "./results.js";
import { signUp } from "./sign-up.js";

/**
 * The identity fields of 3.15 A.1 as a validator. The mode decides which of the two are read, so
 * `/sign-up` in mode `email` refuses a `username` field rather than ignoring it.
 */
function identityFieldsOf(identity: IdentityConfiguration) {
	return identity.mode === "email"
		? { email: string() }
		: identity.mode === "username"
			? { username: string() }
			: { email: string(), username: string() };
}

/** 3.15 A.1: one lookup field in every mode, and in `username_email` it is resolved by format. */
function signInLookupOf(identity: IdentityConfiguration) {
	return identity.mode === "email"
		? { email: string() }
		: identity.mode === "username"
			? { username: string() }
			: { emailOrUsername: string() };
}

interface SubmittedIdentifiers {
	readonly email?: string | undefined;
	readonly username?: string | undefined;
	readonly emailOrUsername?: string | undefined;
}

function identifiersIn(input: SubmittedIdentifiers): {
	readonly email?: string;
	readonly username?: string;
} {
	return {
		...(input.email === undefined ? {} : { email: input.email }),
		...(input.username === undefined ? {} : { username: input.username }),
	};
}

function lookupIn(input: SubmittedIdentifiers): string {
	return input.emailOrUsername ?? input.email ?? input.username ?? "";
}

function addressAndAccount(services: RouteServices): RateLimitRule {
	return {
		perIpAddress: services.rateLimit.perIpAddress,
		perAccount: services.rateLimit.perAccount,
	};
}

function addressOnly(services: RouteServices): RateLimitRule {
	return { perIpAddress: services.rateLimit.perIpAddress, perAccount: "none" };
}

const ANONYMOUS_ERRORS = ["invalid_input", "rate_limited", "origin_not_allowed"] as const;
const SESSION_ERRORS = [
	"invalid_input",
	"session_required",
	"account_disabled",
	"rate_limited",
	"origin_not_allowed",
] as const;

function requireSessionOwner(context: RequestContext): string {
	if (context.session === null) {
		throw new ConcealedError("cookie_absent");
	}
	return context.session.userId;
}

/** The rows of 3.15 D.3 that exist in every identity mode. */
function routesInEveryMode(environment: FlowEnvironment, email: EmailConfig | undefined) {
	const { services } = environment;
	const flow = { environment, email };

	const withPassword = defineRoute({
		name: "signUp.withPassword",
		method: "POST",
		path: "/sign-up",
		input: object({ ...identityFieldsOf(services.identity), password: string() }),
		errors: [
			"invalid_input",
			"password_unacceptable",
			"username_taken",
			"username_invalid",
			"rate_limited",
			"origin_not_allowed",
		] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressAndAccount(services),
		handler: async (input, context): Promise<SignUpResult> =>
			signUp(flow, context, { identifiers: identifiersIn(input), password: input.password }),
	});

	const withoutPassword = defineRoute({
		name: "signUp.withoutPassword",
		method: "POST",
		path: "/sign-up/passwordless",
		input: object(identityFieldsOf(services.identity)),
		errors: [
			"invalid_input",
			"username_taken",
			"username_invalid",
			"rate_limited",
			"origin_not_allowed",
		] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressAndAccount(services),
		handler: async (input, context): Promise<SignUpResult> =>
			signUp(flow, context, { identifiers: identifiersIn(input), password: null }),
	});

	const withRecoveryCode = defineRoute({
		name: "password.redeemResetWithRecoveryCode",
		method: "POST",
		path: "/password/redeem-reset-with-recovery-code",
		input: object({
			...signInLookupOf(services.identity),
			recoveryCode: string(),
			newPassword: string(),
		}),
		errors: [
			"invalid_input",
			"invalid_recovery_code",
			"password_unacceptable",
			"rate_limited",
			"origin_not_allowed",
		] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressAndAccount(services),
		handler: async (input, context): Promise<SetPasswordResult> =>
			redeemResetWithRecoveryCode(environment, context, {
				identifier: lookupIn(input),
				recoveryCode: input.recoveryCode,
				newPassword: input.newPassword,
			}),
	});

	return [withPassword, withoutPassword, withRecoveryCode] as const;
}

/** The eight rows of 3.15 D.3 that carry an address, and therefore are absent in mode `username`. */
function routesThatNeedAnAddress(environment: FlowEnvironment, email: EmailConfig) {
	const { services } = environment;

	const magicLinkRequest = defineRoute({
		name: "signIn.magicLink.request",
		method: "POST",
		path: "/sign-in/magic-link/request",
		input: object({ email: string() }),
		errors: ANONYMOUS_ERRORS,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressAndAccount(services),
		// 3.15 B.1: `void`, not `{ sent: boolean }` — a boolean would be the enumeration answer.
		handler: async (input, context): Promise<void> =>
			requestMagicLink(environment, email, context, input),
	});

	const magicLinkRedeem = defineRoute({
		name: "signIn.magicLink.redeem",
		method: "POST",
		path: "/sign-in/magic-link/redeem",
		input: object({ token: string() }),
		errors: ["invalid_input", "invalid_token", "rate_limited", "origin_not_allowed"] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		handler: async (input, context): Promise<SignInResult> =>
			redeemMagicLink(environment, context, input),
	});

	const verificationRequest = defineRoute({
		name: "email.requestVerification",
		method: "POST",
		path: "/email/request-verification",
		input: object({}),
		errors: SESSION_ERRORS,
		caller: "session",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressAndAccount(services),
		handler: async (_input, context): Promise<void> =>
			requestVerification(environment, email, context, requireSessionOwner(context)),
	});

	const verificationRedeem = defineRoute({
		name: "email.redeemVerification",
		method: "POST",
		path: "/email/redeem-verification",
		input: object({ token: string() }),
		errors: ["invalid_input", "invalid_token", "rate_limited", "origin_not_allowed"] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		handler: async (input, context): Promise<ChangedUser> =>
			redeemVerification(environment, context, input),
	});

	const changeRequest = defineRoute({
		name: "email.requestChange",
		method: "POST",
		path: "/email/request-change",
		input: object({ newEmail: string() }),
		errors: [...SESSION_ERRORS, "freshness_required"] as const,
		caller: "session",
		freshness: "required",
		originCheck: "checked",
		rateLimit: addressAndAccount(services),
		handler: async (input, context): Promise<void> =>
			requestChange(environment, email, context, requireSessionOwner(context), input),
	});

	const changeRedeem = defineRoute({
		name: "email.redeemChange",
		method: "POST",
		path: "/email/redeem-change",
		input: object({ token: string() }),
		errors: ["invalid_input", "invalid_token", "rate_limited", "origin_not_allowed"] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		handler: async (input, context): Promise<ChangedUser> =>
			redeemChange(environment, context, input),
	});

	const resetRequest = defineRoute({
		name: "password.requestReset",
		method: "POST",
		path: "/password/request-reset",
		input: object({ email: string() }),
		errors: ANONYMOUS_ERRORS,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressAndAccount(services),
		handler: async (input, context): Promise<void> =>
			requestReset(environment, email, context, input),
	});

	const resetRedeem = defineRoute({
		name: "password.redeemReset",
		method: "POST",
		path: "/password/redeem-reset",
		input: object({ token: string(), newPassword: string() }),
		errors: [
			"invalid_input",
			"invalid_token",
			"password_unacceptable",
			"rate_limited",
			"origin_not_allowed",
		] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		handler: async (input, context): Promise<SetPasswordResult> =>
			redeemReset(environment, context, input),
	});

	return [
		magicLinkRequest,
		magicLinkRedeem,
		verificationRequest,
		verificationRedeem,
		changeRequest,
		changeRedeem,
		resetRequest,
		resetRedeem,
	] as const;
}

/**
 * Every row this file can contribute, in the order the address-bearing modes assemble them; the
 * value below narrows to the mode, so a caller that needs the whole set as a type — 3.15 E's client
 * is the one — reads it here rather than from the widened return (E-671).
 */
export type EmailFlowRouteTable = readonly [
	...ReturnType<typeof routesInEveryMode>,
	...ReturnType<typeof routesThatNeedAnAddress>,
];

/**
 * The rows of 3.15 D.3 that carry an e-mailed one-time artefact — sign-up, magic link, password
 * reset, address verification and address change. Composed here so that adding them is a change to
 * this file and never to the assembly; the tuple return type carries `signIn.magicLink.*` onto the
 * instance without any other file naming it.
 */
export function emailFlowRoutes(services: RouteServices): readonly AnyRoute[] {
	const environment: FlowEnvironment = {
		services,
		semaphore: services.kdfSemaphore,
	};
	const email = services.email;
	// 3.15 D.3: a route the mode does not have is not refused, it does not exist. `email.send` is a
	// start error in the two modes that have addresses (A.7), so the narrowing below is the mode.
	return email === undefined || services.identity.mode === "username"
		? routesInEveryMode(environment, email)
		: [...routesInEveryMode(environment, email), ...routesThatNeedAnAddress(environment, email)];
}

/**
 * What this feature contributes to `VelveAuth<M>`. `M` is a parameter because the `/email/*` routes
 * exist in `email` and `username_email` and not in `username`, so the namespaces this feature adds
 * are conditional on the mode and the condition is written here (E-776).
 */
export type EmailFlowSurface<M extends IdentityMode> = {
	readonly signUp: SignUpNamespace<M>;
	readonly password: RecoveryPasswordNamespace<M>;
} & (M extends "email" | "username_email"
	? {
			readonly signIn: { readonly magicLink: MagicLinkNamespace };
			readonly email: EmailNamespace;
			readonly password: MailedPasswordNamespace;
		}
	: unknown);
