import type { VelveAuthConfig } from "./core/auth/config.js";
import { assembleVelveAuth, type VelveAuth } from "./core/auth/instance.js";
import type { IdentityMode } from "./core/db/migrations/identity-mode.js";
import type { Clock } from "./core/http/environment.js";

export type {
	BaseConfig,
	EmailConfig,
	EmailMessage,
	IdentityConfig,
	IdentityFields,
	ModeHasEmail,
	ModeHasUsername,
	OnlyWhen,
	RateAlert,
	RateLimitConfig,
	RecoveryCodesConfig,
	RecoveryCodesRequirement,
	SecurityStateConfig,
	SignInLookup,
	TotpConfig,
	VelveAuthConfig,
	WebAuthnConfig,
} from "./core/auth/config.js";
export type {
	AuthInternals,
	PendingNamespace,
	SessionNamespace,
	UserNamespace,
	UsernameNamespace,
	VelveAuth,
} from "./core/auth/instance.js";
export type { SweepReport } from "./core/auth/maintenance.js";
export type {
	Identity,
	OAuthCallbackResult,
	OAuthRedirect,
	SignInResult,
	SignUpResult,
} from "./core/auth/results.js";
export type { ResolvedSessionView } from "./core/auth/routes.js";
export {
	type ChosenWeakening,
	SECURITY_OPTIONS,
	type SecurityOption,
} from "./core/auth/security-options.js";
export type {
	RowsUnderSecurityStateKeyVersion,
	SealedSecurityState,
	SecurityStateMaintenanceError,
	SecurityStateReport,
} from "./core/auth/security-state-maintenance.js";
export { type RouteConflict, THE_CORE, VelveStartupError } from "./core/auth/startup.js";
export {
	TRUST_LEVEL_EVENT_REVOKES_OTHER_SESSIONS,
	TRUST_LEVEL_EVENTS,
	type TrustLevelEvent,
} from "./core/auth/trust-level.js";
export type { ImportSource, User } from "./core/auth/user.js";
export {
	type Actor,
	actorOfConsumedOAuthFlow,
	actorOfRedeemedOneTimeToken,
	actorOfResolvedSession,
	type ConsumedOAuthFlow,
	type RedeemedOneTimeToken,
	type ResolvedSession,
} from "./core/db/actor.js";
export {
	type EntityId,
	type IdentityId,
	type ProviderId,
	type SessionId,
	toEntityId,
	type UserId,
	type WebAuthnCredentialId,
} from "./core/db/entity-id.js";
export type { IdentityMode } from "./core/db/migrations/identity-mode.js";
export {
	createOwnedRowRepository,
	type OwnedRowRepository,
	type OwnedRowRepositoryOptions,
	UnknownColumnError,
} from "./core/db/repositories/owned-row-repository.js";
export type { PendingToken } from "./core/factor/pending/index.js";
/** the return types of the `factor.*` and `signIn.passkey.*` methods and their four namespaces */
export type {
	AuthenticatorResponse,
	RecoveryNamespace,
	SignInPasskeyNamespace,
	TotpNamespace,
	WebAuthnNamespace,
} from "./core/factor/routes.js";
export type { TotpEnrollment } from "./core/factor/totp/index.js";
export type { WebAuthnCredential } from "./core/factor/webauthn/credential-repository.js";
export type {
	WebAuthnAuthenticationChallenge,
	WebAuthnRegistrationChallenge,
} from "./core/factor/webauthn/service.js";
//three writers each own one line here and never meet in this file (E-744)
export type * from "./core/flows/index.js";
export type {
	AuthenticationFactor,
	PendingAuthentication,
	Session,
} from "./core/http/caller.js";
//an application handed a state cookie must be able to name its type (E-753)
export type { CookieAttributes, CookieInstruction } from "./core/http/cookies.js";
export type { Clock } from "./core/http/environment.js";
export {
	type AnyErrorCode,
	type PluginErrorCode,
	type PluginErrorDefinition,
	registerPluginErrorCodes,
	resolveErrorCode,
	VelveError,
	type VelveErrorCode,
} from "./core/http/error-map.js";
export type { AnyRoute, CallerRequirement, OriginRequirement } from "./core/http/route.js";
export type { UsernameRules } from "./core/identity/configuration.js";
export { type KeyProvider, rootKeyProvider } from "./core/keys/index.js";
export type * from "./core/oauth/index.js";
export type * from "./core/plugin/index.js";
export type { SecurityStateAlarm } from "./core/security-state/alarm.js";
export type { LimitsConfig } from "./core/security-state/limits.js";
export type { SessionToken } from "./core/session/token.js";

//this is the one place in the package where a clock is read (E-231)
const SYSTEM_CLOCK: Clock = { now: () => new Date() };

type LogSink = NonNullable<VelveAuthConfig<IdentityMode>["log"]>;

//this is the one place in the package that writes to the console and the core never does (E-2674)
function warnOnTheConsole(...[, message, fields]: Parameters<LogSink>): void {
	//biome-ignore lint/suspicious/noConsole: the fallback sink for weakenings and route alarms
	console.warn(`[@velve/auth] ${message}`, fields ?? {});
}

export function createVelveAuth<M extends IdentityMode>(config: VelveAuthConfig<M>): VelveAuth<M> {
	return assembleVelveAuth(config, SYSTEM_CLOCK, warnOnTheConsole);
}

export const VELVE_AUTH_VERSION = "2.0.0";
