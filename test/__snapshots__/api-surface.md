## client.d.mts

export { };

## http.d.mts

import { WebHandlerOptions, toWebHandler } from "./core/http/web-handler.mjs";
export { type WebHandlerOptions, toWebHandler };

## import.d.mts

export { };

## index.d.mts

import { EntityId, IdentityId, ProviderId, SessionId, UserId, WebAuthnCredentialId, toEntityId } from "./core/db/entity-id.mjs";
import { Actor, ConsumedOAuthFlow, RedeemedOneTimeToken, ResolvedSession, actorOfConsumedOAuthFlow, actorOfRedeemedOneTimeToken, actorOfResolvedSession } from "./core/db/actor.mjs";
import { ImportSource, User } from "./core/auth/user.mjs";
import { IdentityMode } from "./core/db/migrations/identity-mode.mjs";
import { AuthenticationFactor, PendingAuthentication, Session } from "./core/http/caller.mjs";
import { AnyErrorCode, PluginErrorCode, PluginErrorDefinition, VelveError, VelveErrorCode, registerPluginErrorCodes, resolveErrorCode } from "./core/http/error-map.mjs";
import { AnyRoute, CallerRequirement, OriginRequirement } from "./core/http/route.mjs";
import { FrozenContext, FrozenRepositories, PluginActor, PluginHooks, PluginMigration, PluginRoute, RevokeReason, SessionCreateEvent, SessionCreatedEvent, SessionRevokeEvent, SignInCompletedEvent, SignInEvent, UserCreateEvent, UserCreatedEvent, VelvePlugin } from "./core/plugin/config.mjs";
import { Clock } from "./core/http/environment.mjs";
import { UsernameRules } from "./core/identity/configuration.mjs";
import { KeyProvider } from "./core/keys/provider.mjs";
import { GenericProviderConfig, KnownProvider, OAuthConfig, ProviderCredentials } from "./core/oauth/config.mjs";
import { BaseConfig, EmailConfig, EmailMessage, IdentityConfig, IdentityFields, ModeHasEmail, ModeHasUsername, OnlyWhen, RateAlert, RateLimitConfig, RecoveryCodesConfig, RecoveryCodesRequirement, SignInLookup, TotpConfig, VelveAuthConfig, WebAuthnConfig } from "./core/auth/config.mjs";
import { SessionToken } from "./core/session/token.mjs";
import { PendingToken } from "./core/factor/pending/token.mjs";
import { rootKeyProvider } from "./core/keys/root-key-provider.mjs";
import { PluginHookDispatcher, PluginRuntime } from "./core/plugin/registry.mjs";
import { ResolvedSessionView } from "./core/auth/routes.mjs";
import { SweepReport } from "./core/auth/maintenance.mjs";
import { AuthInternals, PendingNamespace, SeamSurface, SessionNamespace, UserNamespace, UsernameNamespace, VelveAuth } from "./core/auth/instance.mjs";
import { Identity, OAuthCallbackResult, OAuthRedirect, SignInResult, SignUpResult } from "./core/auth/results.mjs";
import { SECURITY_OPTIONS, SecurityOption } from "./core/auth/security-options.mjs";
import { VelveStartupError } from "./core/auth/startup.mjs";
import { TRUST_LEVEL_EVENTS, TRUST_LEVEL_EVENT_REVOKES_OTHER_SESSIONS, TrustLevelEvent } from "./core/auth/trust-level.mjs";
import { OwnedRowRepository, OwnedRowRepositoryOptions, UnknownColumnError, createOwnedRowRepository } from "./core/db/repositories/owned-row-repository.mjs";

//#region src/index.d.ts

declare function createVelveAuth<M extends IdentityMode>(config: VelveAuthConfig<M>): VelveAuth<M>;
declare const VELVE_AUTH_VERSION = "0.0.0";
//#endregion
export { type Actor, type AnyErrorCode, type AnyRoute, type AuthInternals, type AuthenticationFactor, type BaseConfig, type CallerRequirement, type Clock, type ConsumedOAuthFlow, type EmailConfig, type EmailMessage, type EntityId, FrozenContext, FrozenRepositories, GenericProviderConfig, type Identity, type IdentityConfig, type IdentityFields, type IdentityId, type IdentityMode, type ImportSource, type KeyProvider, KnownProvider, type ModeHasEmail, type ModeHasUsername, type OAuthCallbackResult, OAuthConfig, type OAuthRedirect, type OnlyWhen, type OriginRequirement, type OwnedRowRepository, type OwnedRowRepositoryOptions, type PendingAuthentication, type PendingNamespace, type PendingToken, PluginActor, type PluginErrorCode, type PluginErrorDefinition, PluginHookDispatcher, PluginHooks, PluginMigration, PluginRoute, PluginRuntime, ProviderCredentials, type ProviderId, type RateAlert, type RateLimitConfig, type RecoveryCodesConfig, type RecoveryCodesRequirement, type RedeemedOneTimeToken, type ResolvedSession, type ResolvedSessionView, RevokeReason, SECURITY_OPTIONS, type SeamSurface, type SecurityOption, type Session, SessionCreateEvent, SessionCreatedEvent, type SessionId, type SessionNamespace, SessionRevokeEvent, type SessionToken, SignInCompletedEvent, SignInEvent, type SignInLookup, type SignInResult, type SignUpResult, type SweepReport, TRUST_LEVEL_EVENTS, TRUST_LEVEL_EVENT_REVOKES_OTHER_SESSIONS, type TotpConfig, type TrustLevelEvent, UnknownColumnError, type User, UserCreateEvent, UserCreatedEvent, type UserId, type UserNamespace, type UsernameNamespace, type UsernameRules, VELVE_AUTH_VERSION, type VelveAuth, type VelveAuthConfig, VelveError, type VelveErrorCode, VelvePlugin, VelveStartupError, type WebAuthnConfig, type WebAuthnCredentialId, actorOfConsumedOAuthFlow, actorOfRedeemedOneTimeToken, actorOfResolvedSession, createOwnedRowRepository, createVelveAuth, registerPluginErrorCodes, resolveErrorCode, rootKeyProvider, toEntityId };

## neon.d.mts

export { };

## pg.d.mts

import { Driver } from "./core/db/driver.mjs";

//#region src/pg/index.d.ts
interface NodePostgresQueryConfig {
  text: string;
  values: unknown[];
}
interface NodePostgresResult {
  rows: unknown[];
}
interface NodePostgresClient {
  query(config: NodePostgresQueryConfig): Promise<NodePostgresResult>;
  release(): void;
}
interface NodePostgresPool {
  query(config: NodePostgresQueryConfig): Promise<NodePostgresResult>;
  connect(): Promise<NodePostgresClient>;
}
declare function createNodePostgresDriver(pool: NodePostgresPool): Driver;
//#endregion
export { NodePostgresClient, NodePostgresPool, NodePostgresQueryConfig, NodePostgresResult, createNodePostgresDriver };

## postgres-js.d.mts

export { };

## schema.d.mts

import { Driver } from "./core/db/driver.mjs";
import { AppliedMigration, Migration, MigrationReport } from "./core/db/migration.mjs";
import { IdentityMode } from "./core/db/migrations/identity-mode.mjs";
import { MissingCascadeError } from "./core/db/cascade-guard.mjs";
import { InvalidIdentifierError } from "./core/db/identifier.mjs";
import { MigrationRefusedError, MigrationRunnerOptions, runMigrations } from "./core/db/migration-runner.mjs";
import { coreMigrations } from "./core/db/migrations/index.mjs";
import { UnrewritableMigrationError } from "./core/db/schema-rewrite.mjs";
import { SchemaStatus, SchemaStatusOptions, SchemaVersionMismatchError, assertSchemaUpToDate, readSchemaStatus } from "./core/db/schema-status.mjs";
export { type AppliedMigration, type Driver, type IdentityMode, InvalidIdentifierError, type Migration, MigrationRefusedError, type MigrationReport, type MigrationRunnerOptions, MissingCascadeError, type SchemaStatus, type SchemaStatusOptions, SchemaVersionMismatchError, UnrewritableMigrationError, assertSchemaUpToDate, coreMigrations, readSchemaStatus, runMigrations };

## testing.d.mts

import { Clock } from "./core/http/environment.mjs";

//#region src/testing/index.d.ts

/**
 * Architecture 6.19: every expiry, window and TOTP test needs a deterministic time, and the core
 * reads the time only through `clock` and through `now()` in the database. This is the `clock` a
 * test hands to the configuration.
 */
interface TestClock extends Clock {
  set(instant: Date): void;
  advanceBy(milliseconds: number): void;
}
declare function createTestClock(start?: Date): TestClock;
//#endregion
export { TestClock, createTestClock };