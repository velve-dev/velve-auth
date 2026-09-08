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
export type { ResolvedSessionView } from "./core/auth/routes.js";
export { SECURITY_OPTIONS, type SecurityOption } from "./core/auth/security-options.js";
export { VelveStartupError } from "./core/auth/startup.js";
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
export type {
	AuthenticationFactor,
	PendingAuthentication,
	Session,
} from "./core/http/caller.js";
export type { Clock } from "./core/http/environment.js";
export {
	type AnyErrorCode,
	forgetPluginErrorCodes,
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
export type {
	GenericProviderConfig,
	KnownProvider,
	OAuthConfig,
	ProviderCredentials,
} from "./core/oauth/config.js";
export type {
	FrozenContext,
	FrozenRepositories,
	PluginActor,
	PluginHooks,
	PluginMigration,
	PluginRoute,
	RevokeReason,
	SessionCreatedEvent,
	SessionCreateEvent,
	SessionRevokeEvent,
	SignInCompletedEvent,
	SignInEvent,
	UserCreatedEvent,
	UserCreateEvent,
	VelvePlugin,
} from "./core/plugin/config.js";

/** E-231: the one place in the package where a clock is read, and the layer above the core. */
const SYSTEM_CLOCK: Clock = { now: () => new Date() };

export function createVelveAuth<M extends IdentityMode>(config: VelveAuthConfig<M>): VelveAuth<M> {
	return assembleVelveAuth(config, SYSTEM_CLOCK);
}

export const VELVE_AUTH_VERSION = "0.0.0";
