## client.d.mts

import { VelveError, VelveErrorCode } from "./core/http/error-map.mjs";
import { AnyRoute } from "./core/http/route.mjs";
import { ClientRoute, VELVE_CLIENT_ROUTES, VelveRouteTable } from "./client/routes.mjs";
import { VelveFailure, VelveResult, VelveTransportError, unwrap } from "./client/result.mjs";
import { ClientMethodOf, ClientSurface } from "./client/surface.mjs";
import { VelveClientOptions } from "./client/transport.mjs";

//#region src/client/index.d.ts

/** the route table an instance declares, read as the library's own table where it was widened */
type RouteTableOf<Auth extends {
  readonly routes: readonly AnyRoute[];
}> = number extends Auth["routes"]["length"] ? VelveRouteTable : Auth["routes"];
/** builds a client whose every call takes its method and path from its own route row */
declare function createVelveClient<Auth extends {
  readonly routes: readonly AnyRoute[];
} = {
  readonly routes: VelveRouteTable;
}>(options: VelveClientOptions): ClientSurface<RouteTableOf<Auth>>;
//#endregion
export {
	type ClientMethodOf,
	type ClientRoute,
	type ClientSurface,
	VELVE_CLIENT_ROUTES,
	type VelveClientOptions,
	VelveError,
	type VelveErrorCode,
	type VelveFailure,
	type VelveResult,
	type VelveRouteTable,
	VelveTransportError,
	createVelveClient,
	unwrap,
};

## client/result.d.mts

import { VelveErrorCode } from "../core/http/error-map.mjs";

//#region src/client/result.d.ts
interface VelveFailure<Code extends VelveErrorCode> {
  readonly code: Code;
  readonly message: string;
  /** present only on `rate_limited` and absent for every other code */
  readonly retryAfterSeconds?: number;
}
/** a result whose `ok` is checked before `value` is readable, with `code` narrowed to the route */
type VelveResult<Value, Code extends VelveErrorCode> = {
  readonly ok: true;
  readonly value: Value;
} | {
  readonly error: VelveFailure<Code>;
  readonly ok: false;
};
/** a failure with no code, where the server did not answer or gave no Velve response */
declare class VelveTransportError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause: unknown);
}
/** returns the value or throws, for a caller that would rather catch than check */
declare function unwrap<Value, Code extends VelveErrorCode>(result: VelveResult<Value, Code>): Value;
//#endregion
export {
	VelveFailure,
	VelveResult,
	VelveTransportError,
	unwrap,
};

## client/routes.d.mts

import { HttpMethod } from "../core/http/route.mjs";
import { pendingRoutes, sessionRoutes, usernameRoutes } from "../core/auth/routes.mjs";
import { FactorRouteTable } from "../core/factor/routes.mjs";
import { EmailFlowRouteTable } from "../core/flows/routes.mjs";
import { oauthRoutes } from "../core/oauth/routes.mjs";
import { passwordRoutes } from "../core/password/routes.mjs";

//#region src/client/routes.d.ts
/** every route the library declares, whatever one instance's mode or configuration serves */
type VelveRouteTable = readonly [...ReturnType<typeof sessionRoutes>, ...ReturnType<typeof usernameRoutes>, ...ReturnType<typeof pendingRoutes>, ...ReturnType<typeof oauthRoutes>, ...EmailFlowRouteTable, ...ReturnType<typeof passwordRoutes>, ...FactorRouteTable];
/** what a call needs from its own route row, with no handler reachable from it */
interface ClientRoute {
  readonly method: HttpMethod;
  readonly name: string;
  readonly path: string;
}
/** the route table as a value, carrying no import of the module that declares the server routes */
declare const VELVE_CLIENT_ROUTES: readonly [{
  readonly method: "POST";
  readonly name: "signOut";
  readonly path: "/sign-out";
}, {
  readonly method: "GET";
  readonly name: "session.read";
  readonly path: "/session";
}, {
  readonly method: "GET";
  readonly name: "session.list";
  readonly path: "/session/list";
}, {
  readonly method: "POST";
  readonly name: "session.revoke";
  readonly path: "/session/revoke";
}, {
  readonly method: "POST";
  readonly name: "session.revokeAllOther";
  readonly path: "/session/revoke-others";
}, {
  readonly method: "POST";
  readonly name: "session.revokeAll";
  readonly path: "/session/revoke-all";
}, {
  readonly method: "POST";
  readonly name: "session.refresh";
  readonly path: "/session/refresh";
}, {
  readonly method: "GET";
  readonly name: "username.isAvailable";
  readonly path: "/username/available";
}, {
  readonly method: "POST";
  readonly name: "username.change";
  readonly path: "/username/change";
}, {
  readonly method: "GET";
  readonly name: "pending.read";
  readonly path: "/pending";
}, {
  readonly method: "POST";
  readonly name: "pending.cancel";
  readonly path: "/pending/cancel";
}, {
  readonly method: "POST";
  readonly name: "signIn.oauth.start";
  readonly path: "/sign-in/oauth/start";
}, {
  readonly method: "GET";
  readonly name: "signIn.oauth.callback";
  readonly path: "/sign-in/oauth/callback/:provider";
}, {
  readonly method: "POST";
  readonly name: "signIn.oauth.callbackFormPost";
  readonly path: "/sign-in/oauth/callback/:provider";
}, {
  readonly method: "GET";
  readonly name: "identity.list";
  readonly path: "/identity/list";
}, {
  readonly method: "POST";
  readonly name: "identity.link.start";
  readonly path: "/identity/link/start";
}, {
  readonly method: "POST";
  readonly name: "identity.unlink";
  readonly path: "/identity/unlink";
}, {
  readonly method: "POST";
  readonly name: "signUp.withPassword";
  readonly path: "/sign-up";
}, {
  readonly method: "POST";
  readonly name: "signUp.withoutPassword";
  readonly path: "/sign-up/passwordless";
}, {
  readonly method: "POST";
  readonly name: "password.redeemResetWithRecoveryCode";
  readonly path: "/password/redeem-reset-with-recovery-code";
}, {
  readonly method: "POST";
  readonly name: "signIn.magicLink.request";
  readonly path: "/sign-in/magic-link/request";
}, {
  readonly method: "POST";
  readonly name: "signIn.magicLink.redeem";
  readonly path: "/sign-in/magic-link/redeem";
}, {
  readonly method: "POST";
  readonly name: "email.requestVerification";
  readonly path: "/email/request-verification";
}, {
  readonly method: "POST";
  readonly name: "email.redeemVerification";
  readonly path: "/email/redeem-verification";
}, {
  readonly method: "POST";
  readonly name: "email.requestChange";
  readonly path: "/email/request-change";
}, {
  readonly method: "POST";
  readonly name: "email.redeemChange";
  readonly path: "/email/redeem-change";
}, {
  readonly method: "POST";
  readonly name: "password.requestReset";
  readonly path: "/password/request-reset";
}, {
  readonly method: "POST";
  readonly name: "password.redeemReset";
  readonly path: "/password/redeem-reset";
}, {
  readonly method: "POST";
  readonly name: "signIn.password";
  readonly path: "/sign-in/password";
}, {
  readonly method: "POST";
  readonly name: "password.set";
  readonly path: "/password/set";
}, {
  readonly method: "POST";
  readonly name: "password.change";
  readonly path: "/password/change";
}, {
  readonly method: "POST";
  readonly name: "factor.totp.enroll.start";
  readonly path: "/factor/totp/enroll/start";
}, {
  readonly method: "POST";
  readonly name: "factor.totp.enroll.finish";
  readonly path: "/factor/totp/enroll/finish";
}, {
  readonly method: "POST";
  readonly name: "factor.totp.verify";
  readonly path: "/factor/totp/verify";
}, {
  readonly method: "POST";
  readonly name: "factor.totp.remove";
  readonly path: "/factor/totp/remove";
}, {
  readonly method: "POST";
  readonly name: "factor.recovery.generate";
  readonly path: "/factor/recovery/generate";
}, {
  readonly method: "POST";
  readonly name: "factor.recovery.verify";
  readonly path: "/factor/recovery/verify";
}, {
  readonly method: "GET";
  readonly name: "factor.recovery.remaining";
  readonly path: "/factor/recovery/remaining";
}, {
  readonly method: "POST";
  readonly name: "factor.webauthn.register.start";
  readonly path: "/factor/webauthn/register/start";
}, {
  readonly method: "POST";
  readonly name: "factor.webauthn.register.finish";
  readonly path: "/factor/webauthn/register/finish";
}, {
  readonly method: "POST";
  readonly name: "factor.webauthn.authenticate.start";
  readonly path: "/factor/webauthn/authenticate/start";
}, {
  readonly method: "POST";
  readonly name: "factor.webauthn.authenticate.finish";
  readonly path: "/factor/webauthn/authenticate/finish";
}, {
  readonly method: "GET";
  readonly name: "factor.webauthn.list";
  readonly path: "/factor/webauthn/list";
}, {
  readonly method: "POST";
  readonly name: "factor.webauthn.rename";
  readonly path: "/factor/webauthn/rename";
}, {
  readonly method: "POST";
  readonly name: "factor.webauthn.remove";
  readonly path: "/factor/webauthn/remove";
}, {
  readonly method: "POST";
  readonly name: "signIn.passkey.start";
  readonly path: "/sign-in/passkey/start";
}, {
  readonly method: "POST";
  readonly name: "signIn.passkey.finish";
  readonly path: "/sign-in/passkey/finish";
}];
//#endregion
export {
	ClientRoute,
	VELVE_CLIENT_ROUTES,
	VelveRouteTable,
};

## client/surface.d.mts

import { VelveErrorCode } from "../core/http/error-map.mjs";
import { AnyRoute, Nest, Route, UnionToIntersection } from "../core/http/route.mjs";
import { VelveResult } from "./result.mjs";

//#region src/client/surface.d.ts
/** a server method as the browser calls it, with no envelope and a result instead of a throw */
type ClientMethodOf<Declared> = Declared extends Route<string, string, infer Input, infer Output, infer Code> ? [Code] extends [VelveErrorCode] ? (input: Input) => Promise<VelveResult<Output, Code>> : never : never;
type ClientSurface<Routes extends readonly AnyRoute[]> = UnionToIntersection<{ [Index in keyof Routes]: Nest<Routes[Index]["name"], ClientMethodOf<Routes[Index]>> }[number]>;
//#endregion
export {
	ClientMethodOf,
	ClientSurface,
};

## client/transport.d.mts

import "./routes.mjs";

//#region src/client/transport.d.ts
interface VelveClientOptions {
  readonly baseURL: string;
  readonly fetch?: typeof globalThis.fetch;
}
//#endregion
export {
	VelveClientOptions,
};

## core/auth/config.d.mts

import { Driver } from "../db/driver.mjs";
import { IdentityMode } from "../db/migrations/identity-mode.mjs";
import { BucketRule } from "../http/rate-limit.mjs";
import { Clock } from "../http/environment.mjs";
import { VelvePlugin } from "../plugin/config.mjs";
import { SessionConfig } from "../session/config.mjs";
import { SessionMetadataMode } from "../session/metadata.mjs";
import { IdentityConfigurationInput } from "../identity/configuration.mjs";
import { KeyProvider } from "../keys/provider.mjs";
import { OAuthConfig } from "../oauth/config.mjs";
import { PasswordConfig } from "../password/config.mjs";

//#region src/core/auth/config.d.ts
/** the identity fields each identity mode carries, one row per mode */
interface IdentityFieldsByMode {
  email: {
    email: string;
  };
  username: {
    username: string;
  };
  username_email: {
    email: string;
    username: string;
  };
}
interface SignInLookupByMode {
  email: {
    email: string;
  };
  username: {
    username: string;
  };
  username_email: {
    emailOrUsername: string;
  };
}
type IdentityFields<M extends IdentityMode> = IdentityFieldsByMode[M];
type SignInLookup<M extends IdentityMode> = SignInLookupByMode[M];
type ModeHasEmail<M extends IdentityMode> = M extends "email" | "username_email" ? true : false;
type ModeHasUsername<M extends IdentityMode> = M extends "username" | "username_email" ? true : false;
type OnlyWhen<Condition extends boolean, Surface> = Condition extends true ? Surface : never;
interface RecoveryCodesConfig {
  readonly count: number;
  readonly groupSize: number;
}
interface TotpConfig {
  readonly issuer: string;
  readonly stepToleranceInSteps: 0 | 1;
}
interface WebAuthnConfig {
  readonly origins: readonly string[];
  readonly relyingPartyId: string;
  readonly relyingPartyName: string;
  readonly userVerification: "preferred" | "required";
}
/** four kinds answer the four one-time-token purposes and the last two are the enumeration cover */
type EmailMessage = {
  expiresAt: Date;
  kind: "email_verification";
  to: string;
  token: string;
  userId: string;
} | {
  expiresAt: Date;
  kind: "password_reset";
  to: string;
  token: string;
  userId: string;
} | {
  expiresAt: Date;
  kind: "email_change";
  previousEmail: string;
  to: string;
  token: string;
  userId: string;
} | {
  expiresAt: Date;
  kind: "magic_link";
  to: string;
  token: string;
  userId: string;
} | {
  kind: "sign_up_attempt_on_existing_account";
  to: string;
  userId: string;
} | {
  kind: "request_for_unknown_address";
  requested: "magic_link" | "password_reset";
  to: string;
};
interface EmailConfig {
  send: (message: EmailMessage) => Promise<void>;
}
interface RateAlert {
  readonly observedAt: Date;
  readonly requestsInLastMinute: number;
  readonly routeName: string;
}
interface RateLimitConfig {
  readonly perAccount: BucketRule;
  readonly perIpAddress: BucketRule;
  readonly globalPerRoute: {
    readonly alertThresholdPerMinute: number;
    readonly onAlert: (alert: RateAlert) => void;
  };
}
/** the identity options for mode `M`, where only a username mode carries the username rules */
type IdentityConfig<M extends IdentityMode> = IdentityConfigurationInput & {
  readonly mode: M;
};
/** a username mode without recovery codes is a compile error as well as a start error */
type RecoveryCodesRequirement<M extends IdentityMode> = M extends "username" ? {
  recoveryCodes: RecoveryCodesConfig;
} : {
  recoveryCodes?: RecoveryCodesConfig;
};
interface BaseConfig<M extends IdentityMode> {
  readonly clock?: Clock;
  readonly database: Driver;
  readonly email?: EmailConfig;
  /** the fetch used for outbound provider calls, `globalThis.fetch` when absent */
  readonly fetch?: typeof globalThis.fetch;
  readonly identity: IdentityConfig<M>;
  readonly keys: KeyProvider;
  readonly log?: (level: "error" | "info" | "warn", message: string, fields?: Readonly<Record<string, unknown>>) => void;
  readonly oauth?: OAuthConfig;
  readonly origins: readonly string[];
  readonly password?: PasswordConfig;
  /** a second connection that logs in as the plugin role, on which every plugin statement runs */
  readonly pluginDatabase?: Driver;
  /** the PostgreSQL role every plugin statement is switched to, holding rights on the plugins' own tables only */
  readonly pluginDatabaseRole?: string;
  readonly plugins?: readonly VelvePlugin[];
  readonly rateLimit?: Partial<RateLimitConfig>;
  readonly schema?: string;
  readonly session?: Partial<SessionConfig>;
  readonly sessionMetadata?: SessionMetadataMode;
  readonly totp?: Partial<TotpConfig>;
  readonly trustedProxies?: readonly string[];
  readonly webauthn?: WebAuthnConfig;
}
type VelveAuthConfig<M extends IdentityMode> = BaseConfig<M> & RecoveryCodesRequirement<M>;
//#endregion
export {
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
};

## core/auth/instance.d.mts

import { User } from "./user.mjs";
import { MigrationReport } from "../db/migration.mjs";
import { IdentityMode } from "../db/migrations/identity-mode.mjs";
import { PendingAuthentication, Session } from "../http/caller.mjs";
import { HttpEnvironment } from "../http/environment.mjs";
import { VelveErrorCode } from "../http/error-map.mjs";
import { AnyRoute, ServerCallFields } from "../http/route.mjs";
import { PendingToken } from "../factor/pending/token.mjs";
import { ModeHasUsername } from "./config.mjs";
import { ResolvedSessionView, UsernameAvailabilityAnswer } from "./routes.mjs";
import { FactorSurface } from "../factor/routes.mjs";
import { EmailFlowSurface } from "../flows/routes.mjs";
import { OAuthSurface } from "../oauth/routes.mjs";
import { PasswordSurface } from "../password/routes.mjs";
import { PluginSurface } from "../plugin/routes.mjs";
import { SweepReport } from "./maintenance.mjs";
import { ChosenWeakening } from "./security-options.mjs";

//#region src/core/auth/instance.d.ts
interface SessionNamespace {
  resolve(input: {
    sessionToken: string;
  } & ServerCallFields): Promise<ResolvedSessionView | null>;
  resolveFromHeaders(headers: Headers): Promise<ResolvedSessionView | null>;
  list(input: ServerCallFields): Promise<Session[]>;
  revoke(input: {
    targetSessionId: string;
  } & ServerCallFields): Promise<void>;
  revokeAllOther(input: ServerCallFields): Promise<{
    revokedCount: number;
  }>;
  revokeAll(input: ServerCallFields): Promise<{
    revokedCount: number;
  }>;
  refresh(input: ServerCallFields): Promise<ResolvedSessionView | null>;
}
/** the intermediate state names the factors still open and never any user data */
interface PendingNamespace {
  resolve(token: PendingToken): Promise<PendingAuthentication | null>;
  resolveFromHeaders(headers: Headers): Promise<PendingAuthentication | null>;
  cancel(input: {
    pendingToken: PendingToken;
  }): Promise<void>;
}
/** what the application calls in its own process after its own authorization decision */
interface UserNamespace {
  findById(input: {
    userId: string;
  }): Promise<User | null>;
  findByEmail(input: {
    email: string;
  }): Promise<User | null>;
  disable(input: {
    reason: string;
    userId: string;
  }): Promise<void>;
  enable(input: {
    userId: string;
  }): Promise<void>;
  delete(input: {
    userId: string;
  }): Promise<void>;
}
interface UsernameNamespace {
  isAvailable(input: {
    username: string;
  } & ServerCallFields): Promise<UsernameAvailabilityAnswer>;
  change(input: {
    newUsername: string;
  } & ServerCallFields): Promise<{
    readonly user: User;
  }>;
}
interface AuthInternals {
  readonly errorCodes: readonly VelveErrorCode[];
  readonly identityMode: IdentityMode;
  readonly routes: readonly AnyRoute[];
  readonly maintenance: {
    sweep(): Promise<SweepReport>;
  };
  /** the one asynchronous start step, and where the key ring report runs */
  migrate(): Promise<MigrationReport>;
  close(): Promise<void>;
  /** the HTTP environment `toWebHandler` reads from the instance */
  readonly http: HttpEnvironment;
  /** every option the start reported as weaker than its default, in the shape it was reported */
  readonly weakenings: readonly ChosenWeakening[];
}
/** what each feature's own seam module contributes to the surface, joined into one type */
type SeamSurface<M extends IdentityMode> = OAuthSurface<M> & EmailFlowSurface<M> & PasswordSurface<M> & PluginSurface<M> & FactorSurface;
type VelveAuth<M extends IdentityMode> = AuthInternals & SeamSurface<M> & {
  signOut(input: ServerCallFields): Promise<void>;
  readonly pending: PendingNamespace;
  readonly session: SessionNamespace;
  readonly user: UserNamespace;
} & (ModeHasUsername<M> extends true ? {
  readonly username: UsernameNamespace;
} : Record<never, never>);
//#endregion
export {
	AuthInternals,
	PendingNamespace,
	SessionNamespace,
	UserNamespace,
	UsernameNamespace,
	VelveAuth,
};

## core/auth/maintenance.d.mts

//#region src/core/auth/maintenance.d.ts
interface SweepReport {
  readonly deletedRowsByTable: Readonly<Record<string, number>>;
}
//#endregion
export {
	SweepReport,
};

## core/auth/results.d.mts

import { User } from "./user.mjs";
import { PendingAuthentication, Session } from "../http/caller.mjs";
import { CookieInstruction } from "../http/cookies.mjs";
import { SessionToken } from "../session/token.mjs";
import { PendingToken } from "../factor/pending/token.mjs";

//#region src/core/auth/results.d.ts
/** a linked provider identity whose `profile` the library neither reads nor promises a shape for */
interface Identity {
  readonly createdAt: Date;
  readonly id: string;
  readonly profile: unknown;
  readonly provider: string;
  readonly providerEmail: string | null;
  readonly providerEmailVerified: boolean;
  readonly scopes: readonly string[];
  readonly subject: string;
  readonly tokenExpiresAt: Date | null;
}
/** both ways in create a user and a session and differ in the `factors` they record */
interface SignUpResult {
  readonly session: Session;
  readonly sessionToken: SessionToken;
  readonly user: User;
}
/** the `second_factor_required` branch has no session and no `sessionToken` property at all */
type SignInResult = {
  readonly session: Session;
  readonly sessionToken: SessionToken;
  /** set only on the WebAuthn paths, and `undefined` means "not applicable", never "no" */
  readonly signCountRegressed?: boolean;
  readonly status: "signed_in";
  readonly user: User;
} | {
  readonly pending: PendingAuthentication;
  readonly pendingToken: PendingToken;
  readonly status: "second_factor_required";
};
/** the one server result that mentions a cookie, the pointer that has to reach the browser */
interface OAuthRedirect {
  readonly authorizationUrl: string;
  readonly stateCookie: CookieInstruction;
}
/** linking re-issues the session, as a new identity changes the trust level */
type OAuthCallbackResult = SignInResult | {
  readonly identity: Identity;
  readonly session: Session;
  readonly sessionToken: SessionToken;
  readonly status: "identity_linked";
};
//#endregion
export {
	Identity,
	OAuthCallbackResult,
	OAuthRedirect,
	SignInResult,
	SignUpResult,
};

## core/auth/routes.d.mts

import { Driver } from "../db/driver.mjs";
import { User, UserRepository } from "./user.mjs";
import { PendingAuthentication, Session } from "../http/caller.mjs";
import { Clock } from "../http/environment.mjs";
import { Route } from "../http/route.mjs";
import { SessionResolution, SessionService } from "../session/service.mjs";
import { SecondFactorCompletion } from "../factor/pending/complete.mjs";
import { PendingAuthenticationService } from "../factor/pending/service.mjs";
import { IdentityConfiguration, UsernameRules } from "../identity/configuration.mjs";
import { KeyProvider } from "../keys/provider.mjs";
import { OAuthConfig } from "../oauth/config.mjs";
import { ResolvedPasswordConfig } from "../password/config.mjs";
import { KdfSemaphore } from "../password/semaphore.mjs";
import { PluginRuntime } from "../plugin/registry.mjs";
import { OneTimeTokens } from "../token/one-time-token.mjs";
import { EmailConfig, RateLimitConfig, RecoveryCodesConfig, TotpConfig, WebAuthnConfig } from "./config.mjs";

//#region src/core/auth/routes.d.ts
interface ResolvedSessionView {
  readonly session: Session;
  readonly user: User;
}
/** a memo for one request from each resolved session to its resolution, never a cache */
type ResolutionMemo = WeakMap<Session, SessionResolution>;
/** what every route source takes, and the whole of what it takes */
interface RouteServices {
  readonly clock: Clock;
  /** turns a pending row into its session in one transaction, built once */
  readonly completeSecondFactor: SecondFactorCompletion;
  readonly driver: Driver;
  readonly email?: EmailConfig;
  /** the fetch used for outbound provider calls, `globalThis.fetch` when absent */
  readonly fetch?: typeof globalThis.fetch;
  readonly identity: IdentityConfiguration;
  /** the one bound on concurrent key derivation every route source in the process shares */
  readonly kdfSemaphore: KdfSemaphore;
  readonly keys: KeyProvider;
  readonly oauth?: OAuthConfig;
  readonly oneTimeTokens: OneTimeTokens;
  /** the allowed origins, the only name of the application the configuration always carries */
  readonly origins: readonly string[];
  readonly password: ResolvedPasswordConfig;
  readonly pending: PendingAuthenticationService;
  /** the plugins, ordered and frozen, with their routes, contexts and seven hook points */
  readonly pluginRuntime: PluginRuntime;
  readonly rateLimit: RateLimitConfig;
  readonly recoveryCodes?: RecoveryCodesConfig;
  readonly resolutions: ResolutionMemo;
  readonly schema: string;
  readonly sessions: SessionService;
  readonly totp?: Partial<TotpConfig>;
  readonly users: UserRepository;
  /** absent removes the seven `factor.webauthn.*` rows and the two `signIn.passkey.*` ones */
  readonly webauthn?: WebAuthnConfig;
}
declare function sessionRoutes(services: RouteServices): readonly [Route<"signOut", "/sign-out", {} & {}, void, "invalid_input" | "origin_not_allowed" | "rate_limited">, Route<"session.read", "/session", {} & {}, ResolvedSessionView | null, "account_disabled" | "origin_not_allowed">, Route<"session.list", "/session/list", {} & {}, Session[], "account_disabled" | "freshness_required" | "origin_not_allowed" | "rate_limited" | "session_required">, Route<"session.revoke", "/session/revoke", {
  targetSessionId: string;
} & {}, void, "account_disabled" | "freshness_required" | "invalid_input" | "origin_not_allowed" | "rate_limited" | "session_required">, Route<"session.revokeAllOther", "/session/revoke-others", {} & {}, {
  revokedCount: number;
}, "account_disabled" | "freshness_required" | "origin_not_allowed" | "rate_limited" | "session_required">, Route<"session.revokeAll", "/session/revoke-all", {} & {}, {
  revokedCount: number;
}, "account_disabled" | "freshness_required" | "origin_not_allowed" | "rate_limited" | "session_required">, Route<"session.refresh", "/session/refresh", {} & {}, ResolvedSessionView | null, "account_disabled" | "origin_not_allowed" | "rate_limited" | "session_required">];
/** the two pending routes, which read the pending cookie but are not authorised by it */
declare function pendingRoutes(services: RouteServices): readonly [Route<"pending.read", "/pending", {} & {}, PendingAuthentication | null, "origin_not_allowed">, Route<"pending.cancel", "/pending/cancel", {} & {}, void, "invalid_input" | "origin_not_allowed" | "rate_limited">];
interface UsernameAvailabilityAnswer {
  readonly available: boolean;
  readonly reason?: string;
}
/** the one place the enumeration protection ends, bounded hard and offered only with usernames */
declare function usernameRoutes(services: RouteServices, rules: UsernameRules): readonly [Route<"username.isAvailable", "/username/available", {
  username: string;
} & {}, UsernameAvailabilityAnswer, "invalid_input" | "origin_not_allowed" | "rate_limited">, Route<"username.change", "/username/change", {
  newUsername: string;
} & {}, {
  readonly user: User;
}, "account_disabled" | "freshness_required" | "invalid_input" | "origin_not_allowed" | "rate_limited" | "session_required" | "username_invalid" | "username_taken">];
//#endregion
export {
	ResolvedSessionView,
	RouteServices,
	UsernameAvailabilityAnswer,
	pendingRoutes,
	sessionRoutes,
	usernameRoutes,
};

## core/auth/security-options.d.mts

import { IdentityMode } from "../db/migrations/identity-mode.mjs";
import { VelveAuthConfig } from "./config.mjs";

//#region src/core/auth/security-options.d.ts
/** every key of the option type */
type OptionKey = keyof VelveAuthConfig<IdentityMode>;
interface SecurityOption {
  readonly option: OptionKey;
  /** what the library uses when the option is absent */
  readonly safeDefault: string;
  /** what a caller has to write to make it weaker, or the sentence saying nothing does */
  readonly weakenedBy: string;
}
/** every option with its safe default and what a caller has to write to weaken it */
declare const SECURITY_OPTIONS: readonly SecurityOption[];
/** one option the start found weaker than its default, and the value that was chosen for it */
interface ChosenWeakening {
  readonly chosen: string;
  readonly option: OptionKey;
}
//#endregion
export {
	ChosenWeakening,
	SECURITY_OPTIONS,
	SecurityOption,
};

## core/auth/startup.d.mts

//#region src/core/auth/startup.d.ts

type StartupErrorCode = "email_callback_missing" | "keys_missing" | "keys_unusable" | "oauth_provider_incomplete" | "origins_empty" | "plugin_database_and_role_both_set" | "plugin_database_reaches_the_core" | "plugin_dependency_cycle" | "plugin_dependency_missing" | "plugin_error_code_not_namespaced" | "plugin_error_code_undeclared" | "plugin_field_unknown" | "plugin_id_duplicated" | "plugin_migration_table_not_an_identifier" | "plugin_migration_table_not_prefixed" | "plugin_rate_limit_rule_unmatched" | "plugin_route_conflict" | "plugin_route_exempts_the_origin_check" | "plugin_route_reads_a_core_cookie" | "plugin_route_without_address_rate_limit" | "plugin_table_prefix_conflict" | "rate_limit_bucket_unusable" | "recovery_code_shape_unusable" | "recovery_codes_required" | "route_name_segment_reserved" | "route_namespace_conflict";
/** the two contributors a route conflict names in its start error */
interface RouteConflict {
  readonly claimed: string;
  readonly contributors: readonly [string, string];
}
/** the name the library goes by as one of the two contributors to a route conflict */
declare const THE_CORE = "the core";
declare class VelveStartupError extends Error {
  readonly code: StartupErrorCode;
  /** present where the code is a conflict between two contributors, and absent otherwise */
  readonly conflict?: RouteConflict;
  constructor(code: StartupErrorCode, conflict?: RouteConflict);
}
//#endregion
export {
	RouteConflict,
	THE_CORE,
	VelveStartupError,
};

## core/auth/trust-level.d.mts

//#region src/core/auth/trust-level.d.ts
/** the eight events that issue a new token and leave no row of the old trust level standing */
declare const TRUST_LEVEL_EVENTS: readonly ["sign_in_password", "sign_in_passkey", "second_factor_totp", "second_factor_webauthn", "second_factor_recovery_code", "password_change", "password_reset", "identity_linked"];
type TrustLevelEvent = (typeof TRUST_LEVEL_EVENTS)[number];
/** whether each event revokes the account's other sessions as well as re-issuing its own */
declare const TRUST_LEVEL_EVENT_REVOKES_OTHER_SESSIONS: Readonly<Record<TrustLevelEvent, boolean>>;
//#endregion
export {
	TRUST_LEVEL_EVENTS,
	TRUST_LEVEL_EVENT_REVOKES_OTHER_SESSIONS,
	TrustLevelEvent,
};

## core/auth/user.d.mts

import { Actor } from "../db/actor.mjs";

//#region src/core/auth/user.d.ts
/** a user as the caller sees it, without the `username_key` comparison form */
interface User {
  readonly createdAt: Date;
  readonly disabledAt: Date | null;
  readonly email: string | null;
  readonly emailVerifiedAt: Date | null;
  readonly hasPassword: boolean;
  readonly id: string;
  readonly importedFrom: ImportSource | null;
  readonly updatedAt: Date;
  readonly username: string | null;
}
type ImportSource = "auth0" | "clerk" | "firebase" | "nextauth" | "supabase";
interface NewUser {
  readonly email: string | null;
  readonly emailVerifiedAt: Date | null;
  readonly username: string | null;
  /** the comparison form, normalised by `core/identity` and never derived here */
  readonly usernameKey: string | null;
}
/** the user writes, where each address write takes the `Actor` a proof of ownership produced */
interface UserRepository {
  findUserById(userId: string): Promise<User | null>;
  findUserByEmail(email: string): Promise<User | null>;
  findUserByUsernameKey(usernameKey: string): Promise<User | null>;
  createUser(input: NewUser): Promise<User>;
  setEmailVerifiedAt(input: {
    readonly actor: Actor;
    readonly verifiedAt: Date | null;
  }): Promise<void>;
  updateEmail(input: {
    readonly actor: Actor;
    readonly email: string;
    readonly emailVerifiedAt: Date | null;
  }): Promise<void>;
  /** takes the comparison form already normalised, exactly as `createUser` does */
  updateUsername(input: {
    readonly actor: Actor;
    readonly username: string;
    readonly usernameKey: string;
  }): Promise<User | null>;
  setDisabledAt(input: {
    readonly disabled: boolean;
    readonly userId: string;
  }): Promise<void>;
  deleteUser(userId: string): Promise<void>;
}
//#endregion
export {
	ImportSource,
	User,
	UserRepository,
};

## core/db/actor.d.mts

import { UserId } from "./entity-id.mjs";

//#region src/core/db/actor.d.ts
declare const actorBrand: unique symbol;
declare const resolvedSessionBrand: unique symbol;
declare const redeemedOneTimeTokenBrand: unique symbol;
declare const consumedOAuthFlowBrand: unique symbol;
type Actor = string & {
  readonly [actorBrand]: "an owner some proof named";
};
/** the session a lookup resolved, whose brand only session resolution asserts */
type ResolvedSession = {
  readonly userId: string;
} & {
  readonly [resolvedSessionBrand]: "produced by session resolution";
};
/** the account a consumed reset token named, which an account id from a request cannot replace */
type RedeemedOneTimeToken = {
  readonly userId: UserId;
} & {
  readonly [redeemedOneTimeTokenBrand]: "produced by one-time token consumption";
};
/** the account an OAuth flow row named, once the callback has consumed that row */
type ConsumedOAuthFlow = {
  readonly userId: UserId;
} & {
  readonly [consumedOAuthFlowBrand]: "produced by oauth flow consumption";
};
declare function actorOfResolvedSession(session: ResolvedSession): Actor;
declare function actorOfRedeemedOneTimeToken(redeemed: RedeemedOneTimeToken): Actor;
declare function actorOfConsumedOAuthFlow(flow: ConsumedOAuthFlow): Actor;
//#endregion
export {
	Actor,
	ConsumedOAuthFlow,
	RedeemedOneTimeToken,
	ResolvedSession,
	actorOfConsumedOAuthFlow,
	actorOfRedeemedOneTimeToken,
	actorOfResolvedSession,
};

## core/db/cascade-guard.d.mts

//#region src/core/db/cascade-guard.d.ts
declare class MissingCascadeError extends Error {
  readonly code = "migration_missing_cascade";
  constructor(message: string);
}
//#endregion
export {
	MissingCascadeError,
};

## core/db/driver.d.mts

//#region src/core/db/driver.d.ts
interface Driver {
  query<T>(sql: string, params: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T>;
}
//#endregion
export {
	Driver,
};

## core/db/entity-id.d.mts

//#region src/core/db/entity-id.d.ts
declare const entityIdBrand: unique symbol;
/** a row identifier of one table, which neither a token nor another table's id can replace */
type EntityId<Entity extends string> = string & {
  readonly [entityIdBrand]: Entity;
};
type UserId = EntityId<"user">;
type SessionId = EntityId<"session">;
type IdentityId = EntityId<"identity">;
type WebAuthnCredentialId = EntityId<"webauthn_credential">;
/** the provider half of the provider and subject linking key, and not a `uuid` column */
type ProviderId = EntityId<"oauth_provider">;
/** brands a string as a row identifier without checking its shape */
declare function toEntityId<Entity extends string>(value: string): EntityId<Entity>;
//#endregion
export {
	EntityId,
	IdentityId,
	ProviderId,
	SessionId,
	UserId,
	WebAuthnCredentialId,
	toEntityId,
};

## core/db/identifier.d.mts

//#region src/core/db/identifier.d.ts
declare class InvalidIdentifierError extends Error {
  readonly code = "invalid_identifier";
  constructor(identifier: string, reason: string);
}
//#endregion
export {
	InvalidIdentifierError,
};

## core/db/migration-runner.d.mts

import { Driver } from "./driver.mjs";
import { MigrationReport, RunnableMigration } from "./migration.mjs";

//#region src/core/db/migration-runner.d.ts
type MigrationRefusalCode = "migration_checksum_changed" | "migration_created_more_than_a_table" | "migration_duplicate_version" | "migration_foreign_table_changed" | "migration_left_code_behind" | "migration_read_a_foreign_table" | "migration_role_unbounded" | "migration_table_outside_the_schema" | "migration_table_undeclared" | "migration_table_unprefixed" | "migration_write_check_unavailable" | "migration_wrote_a_foreign_table";
declare class MigrationRefusedError extends Error {
  readonly code: MigrationRefusalCode;
  constructor(code: MigrationRefusalCode, message: string);
}
interface MigrationRunnerOptions {
  readonly driver: Driver;
  readonly migrations: readonly RunnableMigration[];
  readonly schema?: string;
}
declare function runMigrations(options: MigrationRunnerOptions): Promise<MigrationReport>;
//#endregion
export {
	MigrationRefusedError,
	MigrationRunnerOptions,
	runMigrations,
};

## core/db/migration.d.mts

//#region src/core/db/migration.d.ts
interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly version: number;
}
/** a migration whose version counts only within its owner, so a plugin may number from 1 */
interface OwnedMigration extends Migration {
  readonly createsTables: readonly string[];
  readonly owner: string;
}
type RunnableMigration = Migration | OwnedMigration;
interface AppliedMigration {
  readonly checksum: string;
  readonly name: string;
  readonly version: number;
}
interface MigrationReport {
  readonly appliedVersions: readonly number[];
  readonly currentVersion: number;
}
//#endregion
export {
	AppliedMigration,
	Migration,
	MigrationReport,
	OwnedMigration,
	RunnableMigration,
};

## core/db/migrations/identity-mode.d.mts

//#region src/core/db/migrations/identity-mode.d.ts
type IdentityMode = "email" | "username" | "username_email";
//#endregion
export {
	IdentityMode,
};

## core/db/migrations/index.d.mts

import { Migration } from "../migration.mjs";
import { IdentityMode } from "./identity-mode.mjs";

//#region src/core/db/migrations/index.d.ts
declare function coreMigrations(identityMode: IdentityMode): readonly Migration[];
//#endregion
export {
	coreMigrations,
};

## core/db/repositories/owned-row-repository.d.mts

import { Actor } from "../actor.mjs";
import { Driver } from "../driver.mjs";

//#region src/core/db/repositories/owned-row-repository.d.ts
interface OwnedRowRepositoryOptions {
  readonly driver: Driver;
  readonly idColumn?: string;
  readonly ownerColumn?: string;
  readonly schema: string;
  readonly table: string;
  readonly updatableColumns?: readonly string[];
}
interface OwnedRowRepository<Row> {
  findOwnedRow(input: {
    actor: Actor;
    id: string;
  }): Promise<Row | null>;
  listOwnedRows(input: {
    actor: Actor;
  }): Promise<Row[]>;
  updateOwnedRow(input: {
    actor: Actor;
    id: string;
    values: Readonly<Record<string, unknown>>;
  }): Promise<Row | null>;
  deleteOwnedRow(input: {
    actor: Actor;
    id: string;
  }): Promise<Row | null>;
  deleteAllOwnedRows(input: {
    actor: Actor;
  }): Promise<number>;
}
declare class UnknownColumnError extends Error {
  readonly code = "unknown_column";
  constructor(table: string, column: string);
}
declare function createOwnedRowRepository<Row>(options: OwnedRowRepositoryOptions): OwnedRowRepository<Row>;
//#endregion
export {
	OwnedRowRepository,
	OwnedRowRepositoryOptions,
	UnknownColumnError,
	createOwnedRowRepository,
};

## core/db/schema-rewrite.d.mts

//#region src/core/db/schema-rewrite.d.ts
declare class UnrewritableMigrationError extends Error {
  readonly code = "migration_unrewritable_body";
  constructor(message: string);
}
//#endregion
export {
	UnrewritableMigrationError,
};

## core/db/schema-status.d.mts

import { Driver } from "./driver.mjs";
import { Migration } from "./migration.mjs";

//#region src/core/db/schema-status.d.ts
interface SchemaStatus {
  readonly appliedVersions: readonly number[];
  readonly changedVersions: readonly number[];
  readonly currentVersion: number;
  readonly expectedVersion: number;
  readonly pendingVersions: readonly number[];
  readonly upToDate: boolean;
}
interface SchemaStatusOptions {
  readonly driver: Driver;
  readonly migrations: readonly Migration[];
  readonly schema?: string;
}
declare class SchemaVersionMismatchError extends Error {
  readonly code = "schema_version_mismatch";
  readonly status: SchemaStatus;
  constructor(status: SchemaStatus);
}
declare function readSchemaStatus(options: SchemaStatusOptions): Promise<SchemaStatus>;
declare function assertSchemaUpToDate(options: SchemaStatusOptions): Promise<SchemaStatus>;
//#endregion
export {
	SchemaStatus,
	SchemaStatusOptions,
	SchemaVersionMismatchError,
	assertSchemaUpToDate,
	readSchemaStatus,
};

## core/factor/pending/complete.d.mts

import { IssuedSession, ObservedRequest } from "../../session/service.mjs";
import { SecondFactor } from "./repository.mjs";
import { PendingToken } from "./token.mjs";

//#region src/core/factor/pending/complete.d.ts

interface SecondFactorCompletion {
  complete(input: {
    readonly factor: SecondFactor;
    readonly observed: ObservedRequest;
    readonly pendingToken: PendingToken;
    readonly presentedSessionToken: string | null;
  }): Promise<IssuedSession>;
}
//#endregion
export {
	SecondFactorCompletion,
};

## core/factor/pending/repository.d.mts

//#region src/core/factor/pending/repository.d.ts

type SecondFactor = "recovery" | "totp" | "webauthn";
//#endregion
export {
	SecondFactor,
};

## core/factor/pending/service.d.mts

import { AuthenticationFactor, PendingAuthentication, ResolvedPendingAuthentication } from "../../http/caller.mjs";
import { PendingToken } from "./token.mjs";

//#region src/core/factor/pending/service.d.ts

interface IssuedPendingAuthentication {
  readonly pending: PendingAuthentication;
  readonly token: PendingToken;
}
/** the resolved intermediate state, which is not a session and mints no `Actor` */
type PendingResolution = ResolvedPendingAuthentication;
interface ConsumedPendingAuthentication {
  readonly factorsCompleted: readonly AuthenticationFactor[];
  readonly userId: string;
}
type FailedAttempt = {
  readonly attemptsRemaining: number;
  readonly outcome: "attempts_remain";
} | {
  readonly outcome: "exhausted";
};
interface PendingAuthenticationService {
  begin(input: {
    readonly factorsCompleted: readonly AuthenticationFactor[];
    readonly userId: string;
  }): Promise<IssuedPendingAuthentication>;
  resolve(token: PendingToken): Promise<PendingResolution | null>;
  consume(token: PendingToken): Promise<ConsumedPendingAuthentication>;
  registerFailedAttempt(token: PendingToken): Promise<FailedAttempt>;
  cancel(input: {
    readonly token: PendingToken;
  }): Promise<void>;
}
//#endregion
export {
	PendingAuthenticationService,
	PendingResolution,
};

## core/factor/pending/token.d.mts

//#region src/core/factor/pending/token.d.ts
declare const pendingTokenBrand: unique symbol;
/** the intermediate state's own token, never interchangeable with a session token */
type PendingToken = string & {
  readonly [pendingTokenBrand]: "pending authentication";
};
//#endregion
export {
	PendingToken,
};

## core/factor/recovery/service.d.mts

import { Actor } from "../../db/actor.mjs";
import { PendingToken } from "../pending/token.mjs";
import { PendingResolution } from "../pending/service.mjs";

//#region src/core/factor/recovery/service.d.ts

interface RecoveryCodeService {
  /** returns the plaintext codes exactly once, and only their HMAC is stored */
  generate(input: {
    readonly actor: Actor;
  }): Promise<{
    readonly codes: readonly string[];
  }>;
  /** returns the resolution and does not consume the pending state */
  verify(input: {
    readonly code: string;
    readonly pendingToken: PendingToken;
  }): Promise<PendingResolution>;
  remaining(input: {
    readonly actor: Actor;
  }): Promise<{
    readonly remainingCount: number;
  }>;
}
//#endregion
export {
	RecoveryCodeService,
};

## core/factor/routes.d.mts

import { Route, ServerCallFields } from "../http/route.mjs";
import { RouteServices } from "../auth/routes.mjs";
import { SignInResult } from "../auth/results.mjs";
import { RecoveryCodeService } from "./recovery/service.mjs";
import { TotpEnrollment } from "./totp/secret.mjs";
import { TotpService } from "./totp/service.mjs";
import { WebAuthnCredential } from "./webauthn/credential-repository.mjs";
import { WebAuthnAuthenticationChallenge, WebAuthnRegistrationChallenge, WebAuthnService } from "./webauthn/service.mjs";

//#region src/core/factor/routes.d.ts
/** what the authenticator hands back, checked for shape and judged by the verifier */
type AuthenticatorResponse = Record<string, unknown>;
interface TotpNamespace {
  readonly enroll: {
    start(input: ServerCallFields): Promise<TotpEnrollment>;
    finish(input: {
      code: string;
    } & ServerCallFields): Promise<void>;
  };
  verify(input: {
    code: string;
  } & ServerCallFields): Promise<SignInResult>;
  remove(input: {
    code: string;
  } & ServerCallFields): Promise<void>;
}
interface WebAuthnNamespace {
  readonly register: {
    start(input: ServerCallFields): Promise<WebAuthnRegistrationChallenge>;
    finish(input: {
      challengeToken: string;
      label: string;
      response: AuthenticatorResponse;
    } & ServerCallFields): Promise<{
      credential: WebAuthnCredential;
    }>;
  };
  readonly authenticate: {
    start(input: ServerCallFields): Promise<WebAuthnAuthenticationChallenge>;
    finish(input: {
      challengeToken: string;
      response: AuthenticatorResponse;
    } & ServerCallFields): Promise<SignInResult>;
  };
  list(input: ServerCallFields): Promise<WebAuthnCredential[]>;
  rename(input: {
    credentialId: string;
    label: string;
  } & ServerCallFields): Promise<{
    credential: WebAuthnCredential;
  }>;
  remove(input: {
    credentialId: string;
  } & ServerCallFields): Promise<void>;
}
interface RecoveryNamespace {
  generate(input: ServerCallFields): Promise<{
    codes: readonly string[];
  }>;
  verify(input: {
    code: string;
  } & ServerCallFields): Promise<SignInResult>;
  remaining(input: ServerCallFields): Promise<{
    remainingCount: number;
  }>;
}
interface SignInPasskeyNamespace {
  start(input: ServerCallFields): Promise<WebAuthnAuthenticationChallenge>;
  finish(input: {
    challengeToken: string;
    response: AuthenticatorResponse;
  } & ServerCallFields): Promise<SignInResult>;
}
/** the `factor` namespaces, with `factor.webauthn` absent at run time unless configured */
type FactorSurface = {
  readonly factor: {
    readonly recovery: RecoveryNamespace;
    readonly totp: TotpNamespace;
    readonly webauthn: WebAuthnNamespace;
  };
  readonly signIn: {
    readonly passkey: SignInPasskeyNamespace;
  };
};
declare function totpRoutes(services: RouteServices, totp: TotpService): readonly [Route<"factor.totp.enroll.start", "/factor/totp/enroll/start", {} & {}, TotpEnrollment, "account_disabled" | "factor_already_enrolled" | "freshness_required" | "invalid_input" | "origin_not_allowed" | "rate_limited" | "session_required">, Route<"factor.totp.enroll.finish", "/factor/totp/enroll/finish", {
  code: string;
} & {}, void, "account_disabled" | "factor_already_enrolled" | "factor_not_enrolled" | "freshness_required" | "invalid_factor_code" | "invalid_input" | "origin_not_allowed" | "rate_limited" | "session_required">, Route<"factor.totp.verify", "/factor/totp/verify", {
  code: string;
} & {}, SignInResult, "invalid_factor_code" | "invalid_input" | "invalid_pending_authentication" | "origin_not_allowed" | "rate_limited" | "too_many_factor_attempts">, Route<"factor.totp.remove", "/factor/totp/remove", {
  code: string;
} & {}, void, "account_disabled" | "factor_not_enrolled" | "freshness_required" | "invalid_factor_code" | "invalid_input" | "origin_not_allowed" | "rate_limited" | "session_required">];
declare function recoveryRoutes(services: RouteServices, recovery: RecoveryCodeService): readonly [Route<"factor.recovery.generate", "/factor/recovery/generate", {} & {}, {
  codes: readonly string[];
}, "account_disabled" | "freshness_required" | "invalid_input" | "origin_not_allowed" | "rate_limited" | "session_required">, Route<"factor.recovery.verify", "/factor/recovery/verify", {
  code: string;
} & {}, SignInResult, "invalid_input" | "invalid_pending_authentication" | "invalid_recovery_code" | "origin_not_allowed" | "rate_limited" | "too_many_factor_attempts">, Route<"factor.recovery.remaining", "/factor/recovery/remaining", {} & {}, {
  remainingCount: number;
}, "account_disabled" | "origin_not_allowed" | "rate_limited" | "session_required">];
declare function webAuthnRoutes(services: RouteServices, webauthn: WebAuthnService): readonly [Route<"factor.webauthn.register.start", "/factor/webauthn/register/start", {} & {}, WebAuthnRegistrationChallenge, "account_disabled" | "freshness_required" | "invalid_input" | "origin_not_allowed" | "rate_limited" | "session_required">, Route<"factor.webauthn.register.finish", "/factor/webauthn/register/finish", {
  challengeToken: string;
  label: string;
  response: Record<string, unknown>;
} & {}, {
  credential: WebAuthnCredential;
}, "account_disabled" | "freshness_required" | "invalid_input" | "origin_not_allowed" | "rate_limited" | "session_required" | "webauthn_challenge_invalid" | "webauthn_credential_rejected">, Route<"factor.webauthn.authenticate.start", "/factor/webauthn/authenticate/start", {} & {}, WebAuthnAuthenticationChallenge, "factor_not_enrolled" | "invalid_input" | "invalid_pending_authentication" | "origin_not_allowed" | "rate_limited">, Route<"factor.webauthn.authenticate.finish", "/factor/webauthn/authenticate/finish", {
  challengeToken: string;
  response: Record<string, unknown>;
} & {}, SignInResult, "invalid_input" | "invalid_pending_authentication" | "origin_not_allowed" | "rate_limited" | "too_many_factor_attempts" | "webauthn_challenge_invalid" | "webauthn_credential_rejected">, Route<"factor.webauthn.list", "/factor/webauthn/list", {} & {}, WebAuthnCredential[], "account_disabled" | "origin_not_allowed" | "rate_limited" | "session_required">, Route<"factor.webauthn.rename", "/factor/webauthn/rename", {
  credentialId: string;
  label: string;
} & {}, {
  credential: WebAuthnCredential;
}, "account_disabled" | "invalid_input" | "origin_not_allowed" | "rate_limited" | "session_required">, Route<"factor.webauthn.remove", "/factor/webauthn/remove", {
  credentialId: string;
} & {}, void, "account_disabled" | "freshness_required" | "invalid_input" | "last_sign_in_method" | "origin_not_allowed" | "rate_limited" | "session_required">];
declare function passkeyRoutes(services: RouteServices, webauthn: WebAuthnService): readonly [Route<"signIn.passkey.start", "/sign-in/passkey/start", {} & {}, WebAuthnAuthenticationChallenge, "invalid_input" | "origin_not_allowed" | "rate_limited">, Route<"signIn.passkey.finish", "/sign-in/passkey/finish", {
  challengeToken: string;
  response: Record<string, unknown>;
} & {}, SignInResult, "invalid_input" | "origin_not_allowed" | "rate_limited" | "webauthn_challenge_invalid" | "webauthn_credential_rejected">];
/** every second factor route, in the order they are assembled */
type FactorRouteTable = readonly [...ReturnType<typeof totpRoutes>, ...ReturnType<typeof recoveryRoutes>, ...ReturnType<typeof webAuthnRoutes>, ...ReturnType<typeof passkeyRoutes>];
//#endregion
export {
	AuthenticatorResponse,
	FactorRouteTable,
	FactorSurface,
	RecoveryNamespace,
	SignInPasskeyNamespace,
	TotpNamespace,
	WebAuthnNamespace,
};

## core/factor/totp/secret.d.mts

//#region src/core/factor/totp/secret.d.ts

interface TotpEnrollment {
  readonly otpauthUri: string;
  readonly secretBase32: string;
}
//#endregion
export {
	TotpEnrollment,
};

## core/factor/totp/service.d.mts

import { Actor } from "../../db/actor.mjs";
import { PendingToken } from "../pending/token.mjs";
import { PendingResolution } from "../pending/service.mjs";
import { TotpEnrollment } from "./secret.mjs";

//#region src/core/factor/totp/service.d.ts

interface TotpService {
  enroll: {
    start(input: {
      readonly accountName: string;
      readonly actor: Actor;
    }): Promise<TotpEnrollment>;
    finish(input: {
      readonly actor: Actor;
      readonly code: string;
    }): Promise<void>;
  };
  /** returns the resolution and does not consume the pending state */
  verify(input: {
    readonly code: string;
    readonly pendingToken: PendingToken;
  }): Promise<PendingResolution>;
  remove(input: {
    readonly actor: Actor;
    readonly code: string;
  }): Promise<void>;
  isEnrolled(input: {
    readonly userId: string;
  }): Promise<boolean>;
}
//#endregion
export {
	TotpService,
};

## core/factor/webauthn/config.d.mts

//#region src/core/factor/webauthn/config.d.ts
/** the user verification a registration may ask for, where `"discouraged"` is never an option */
type RegistrationUserVerification = "preferred" | "required";
interface WebAuthnSettings {
  readonly origins: readonly string[];
  readonly registrationUserVerification: RegistrationUserVerification;
  readonly relyingPartyId: string;
  readonly relyingPartyName: string;
}
//#endregion
export {
	WebAuthnSettings,
};

## core/factor/webauthn/credential-repository.d.mts

//#region src/core/factor/webauthn/credential-repository.d.ts

/** a registered credential named by its row uuid, without its credential id, key or counter */
interface WebAuthnCredential {
  readonly aaguid: string | null;
  readonly createdAt: Date;
  readonly id: string;
  readonly isBackupEligible: boolean;
  readonly isCurrentlyBackedUp: boolean;
  readonly label: string;
  readonly lastUsedAt: Date | null;
  readonly transports: readonly string[];
  readonly wasUserVerifiedAtRegistration: boolean;
}
//#endregion
export {
	WebAuthnCredential,
};

## core/factor/webauthn/service.d.mts

import { Actor } from "../../db/actor.mjs";
import { PendingResolution } from "../pending/service.mjs";
import { WebAuthnCredential } from "./credential-repository.mjs";
import { WebAuthnSettings } from "./config.mjs";
import { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

//#region src/core/factor/webauthn/service.d.ts
/** the options and challenge token a browser needs to register a credential */
interface WebAuthnRegistrationChallenge {
  readonly challengeToken: string;
  readonly publicKeyOptions: PublicKeyCredentialCreationOptionsJSON;
}
/** the options and challenge token to sign in with a credential, as a second factor or a passkey */
interface WebAuthnAuthenticationChallenge {
  readonly challengeToken: string;
  readonly publicKeyOptions: PublicKeyCredentialRequestOptionsJSON;
}
interface VerifiedWebAuthnAssertion {
  readonly credential: WebAuthnCredential;
  /** reported and never a rejection, as a synchronised passkey does not keep the counter */
  readonly signCountRegressed: boolean;
  readonly userId: string;
}
interface WebAuthnService {
  readonly settings: WebAuthnSettings;
  register: {
    start(input: {
      actor: Actor;
      userDisplayName?: string;
      userName: string;
    }): Promise<WebAuthnRegistrationChallenge>;
    finish(input: {
      actor: Actor;
      challengeToken: string;
      label: string;
      response: RegistrationResponseJSON;
    }): Promise<{
      credential: WebAuthnCredential;
    }>;
  };
  /** the second factor after a password, acting on the intermediate state and not a session */
  authenticate: {
    start(input: {
      pending: PendingResolution;
    }): Promise<WebAuthnAuthenticationChallenge>;
    finish(input: {
      challengeToken: string;
      pending: PendingResolution;
      response: AuthenticationResponseJSON;
    }): Promise<VerifiedWebAuthnAssertion>;
  };
  passkey: {
    start(): Promise<WebAuthnAuthenticationChallenge>;
    finish(input: {
      challengeToken: string;
      response: AuthenticationResponseJSON;
    }): Promise<VerifiedWebAuthnAssertion>;
  };
  list(input: {
    actor: Actor;
  }): Promise<WebAuthnCredential[]>;
  rename(input: {
    actor: Actor;
    credentialId: string;
    label: string;
  }): Promise<{
    credential: WebAuthnCredential;
  }>;
  remove(input: {
    actor: Actor;
    credentialId: string;
  }): Promise<void>;
}
//#endregion
export {
	WebAuthnAuthenticationChallenge,
	WebAuthnRegistrationChallenge,
	WebAuthnService,
};

## core/flows/environment.d.mts

import { KdfSemaphore } from "../password/semaphore.mjs";
import { RouteServices } from "../auth/routes.mjs";

//#region src/core/flows/environment.d.ts

interface FlowEnvironment {
  /** the key derivation bound sign-in is under, which a sign-up wave cannot displace */
  readonly semaphore: KdfSemaphore;
  readonly services: RouteServices;
}
//#endregion
export {
	FlowEnvironment,
};

## core/flows/results.d.mts

import { User } from "../auth/user.mjs";
import { IdentityMode } from "../db/migrations/identity-mode.mjs";
import { Session } from "../http/caller.mjs";
import { ServerCallFields } from "../http/route.mjs";
import { SessionToken } from "../session/token.mjs";
import { IdentityFields, SignInLookup } from "../auth/config.mjs";
import { SignInResult, SignUpResult } from "../auth/results.mjs";

//#region src/core/flows/results.d.ts
/** the result of writing a password */
interface SetPasswordResult {
  /** how many sessions were revoked, which for a reset is every session the account had */
  readonly revokedOtherSessionsCount: number;
  readonly session: Session;
  readonly sessionToken: SessionToken;
}
/** what the two redeeming `/email/*` routes answer with, the account and nothing else */
interface ChangedUser {
  readonly user: User;
}
interface SignUpNamespace<M extends IdentityMode> {
  withPassword(input: IdentityFields<M> & {
    password: string;
  } & ServerCallFields): Promise<SignUpResult>;
  withoutPassword(input: IdentityFields<M> & ServerCallFields): Promise<SignUpResult>;
}
interface MagicLinkNamespace {
  request(input: {
    email: string;
  } & ServerCallFields): Promise<void>;
  redeem(input: {
    token: string;
  } & ServerCallFields): Promise<SignInResult>;
}
interface EmailNamespace {
  requestVerification(input: ServerCallFields): Promise<void>;
  redeemVerification(input: {
    token: string;
  } & ServerCallFields): Promise<ChangedUser>;
  requestChange(input: {
    newEmail: string;
  } & ServerCallFields): Promise<void>;
  redeemChange(input: {
    token: string;
  } & ServerCallFields): Promise<ChangedUser>;
}
/** the password routes that need an address, absent in mode `username` */
interface MailedPasswordNamespace {
  requestReset(input: {
    email: string;
  } & ServerCallFields): Promise<void>;
  redeemReset(input: {
    newPassword: string;
    token: string;
  } & ServerCallFields): Promise<SetPasswordResult>;
}
/** the way back into an account that has no address, present in every mode */
interface RecoveryPasswordNamespace<M extends IdentityMode> {
  redeemResetWithRecoveryCode(input: SignInLookup<M> & {
    newPassword: string;
    recoveryCode: string;
  } & ServerCallFields): Promise<SetPasswordResult>;
}
//#endregion
export {
	ChangedUser,
	EmailNamespace,
	MagicLinkNamespace,
	MailedPasswordNamespace,
	RecoveryPasswordNamespace,
	SetPasswordResult,
	SignUpNamespace,
};

## core/flows/routes.d.mts

import { IdentityMode } from "../db/migrations/identity-mode.mjs";
import { Route } from "../http/route.mjs";
import { EmailConfig } from "../auth/config.mjs";
import { SignInResult, SignUpResult } from "../auth/results.mjs";
import { FlowEnvironment } from "./environment.mjs";
import { ChangedUser, EmailNamespace, MagicLinkNamespace, MailedPasswordNamespace, RecoveryPasswordNamespace, SetPasswordResult, SignUpNamespace } from "./results.mjs";

//#region src/core/flows/routes.d.ts
/** the email flow routes that exist in every identity mode */
declare function routesInEveryMode(environment: FlowEnvironment, email: EmailConfig | undefined): readonly [Route<"signUp.withPassword", "/sign-up", {
  email: string;
  password: string;
  username: string;
} & {}, SignUpResult, "invalid_input" | "origin_not_allowed" | "password_unacceptable" | "rate_limited" | "username_invalid" | "username_taken">, Route<"signUp.withoutPassword", "/sign-up/passwordless", {
  email: string;
  username: string;
} & {}, SignUpResult, "invalid_input" | "origin_not_allowed" | "rate_limited" | "username_invalid" | "username_taken">, Route<"password.redeemResetWithRecoveryCode", "/password/redeem-reset-with-recovery-code", {
  email: string;
  emailOrUsername: string;
  newPassword: string;
  recoveryCode: string;
  username: string;
} & {}, SetPasswordResult, "invalid_input" | "invalid_recovery_code" | "origin_not_allowed" | "password_unacceptable" | "rate_limited">];
/** the eight email flow routes that carry an address, absent in mode `username` */
declare function routesThatNeedAnAddress(environment: FlowEnvironment, email: EmailConfig): readonly [Route<"signIn.magicLink.request", "/sign-in/magic-link/request", {
  email: string;
} & {}, void, "invalid_input" | "origin_not_allowed" | "rate_limited">, Route<"signIn.magicLink.redeem", "/sign-in/magic-link/redeem", {
  token: string;
} & {}, SignInResult, "invalid_input" | "invalid_token" | "origin_not_allowed" | "rate_limited">, Route<"email.requestVerification", "/email/request-verification", {} & {}, void, "account_disabled" | "invalid_input" | "origin_not_allowed" | "rate_limited" | "session_required">, Route<"email.redeemVerification", "/email/redeem-verification", {
  token: string;
} & {}, ChangedUser, "invalid_input" | "invalid_token" | "origin_not_allowed" | "rate_limited">, Route<"email.requestChange", "/email/request-change", {
  newEmail: string;
} & {}, void, "account_disabled" | "freshness_required" | "invalid_input" | "origin_not_allowed" | "rate_limited" | "session_required">, Route<"email.redeemChange", "/email/redeem-change", {
  token: string;
} & {}, ChangedUser, "invalid_input" | "invalid_token" | "origin_not_allowed" | "rate_limited">, Route<"password.requestReset", "/password/request-reset", {
  email: string;
} & {}, void, "invalid_input" | "origin_not_allowed" | "rate_limited">, Route<"password.redeemReset", "/password/redeem-reset", {
  newPassword: string;
  token: string;
} & {}, SetPasswordResult, "invalid_input" | "invalid_token" | "origin_not_allowed" | "password_unacceptable" | "rate_limited">];
/** every route the email flows can contribute, in the order they are assembled */
type EmailFlowRouteTable = readonly [...ReturnType<typeof routesInEveryMode>, ...ReturnType<typeof routesThatNeedAnAddress>];
/** the namespaces the email flows add to `VelveAuth<M>`, absent in mode `username` */
type EmailFlowSurface<M extends IdentityMode> = {
  readonly password: RecoveryPasswordNamespace<M>;
  readonly signUp: SignUpNamespace<M>;
} & (M extends "email" | "username_email" ? {
  readonly signIn: {
    readonly magicLink: MagicLinkNamespace;
  };
  readonly email: EmailNamespace;
  readonly password: MailedPasswordNamespace;
} : unknown);
//#endregion
export {
	EmailFlowRouteTable,
	EmailFlowSurface,
};

## core/http/caller.d.mts

//#region src/core/http/caller.d.ts
type AuthenticationFactor = "oauth" | "password" | "recovery" | "totp" | "webauthn";
/** one signed-in session of an account, as the API presents it */
interface Session {
  readonly absoluteExpiresAt: Date;
  readonly createdAt: Date;
  readonly factors: readonly AuthenticationFactor[];
  readonly id: string;
  readonly idleExpiresAt: Date;
  readonly ipAddress: string | null;
  readonly isCurrent: boolean;
  readonly lastUsedAt: Date;
  readonly userAgent: string | null;
  readonly userId: string;
}
/** a sign-in that has passed its first factor and still awaits a second */
interface PendingAuthentication {
  readonly attemptsRemaining: number;
  readonly availableFactors: readonly ("recovery" | "totp" | "webauthn")[];
  readonly expiresAt: Date;
  readonly factorsCompleted: readonly AuthenticationFactor[];
}
/** the pending state together with the account it belongs to, which the presentation withholds */
interface ResolvedPendingAuthentication {
  /** the database's clock at the moment it answered */
  readonly observedAt: Date;
  readonly pending: PendingAuthentication;
  readonly userId: string;
}
interface CallerResolver {
  resolveSession(sessionToken: string): Promise<Session>;
  resolvePending(pendingToken: string): Promise<ResolvedPendingAuthentication>;
}
//#endregion
export {
	AuthenticationFactor,
	CallerResolver,
	PendingAuthentication,
	ResolvedPendingAuthentication,
	Session,
};

## core/http/cookies.d.mts

//#region src/core/http/cookies.d.ts
type HostPrefixedCookieName = `__Host-${string}`;
type CookieSameSite = "lax" | "strict";
/** the only cookie attribute sets, never with a Domain and never without HttpOnly or Secure */
type CookieAttributes = "HttpOnly; Secure; SameSite=Lax; Path=/" | "HttpOnly; Secure; SameSite=None; Path=/" | "HttpOnly; Secure; SameSite=Strict; Path=/";
interface CookieInstruction {
  readonly attributes: CookieAttributes;
  readonly maximumAgeInSeconds: number;
  readonly name: HostPrefixedCookieName;
  readonly value: string;
}
interface CookieWriter {
  setSession(token: string): void;
  clearSession(): void;
  setPending(token: string): void;
  clearPending(): void;
  setOAuthState(pointer: string): void;
  /** sets the state cookie for a `form_post` callback the browser reaches by a cross-site POST */
  setCrossSiteOAuthState(pointer: string): void;
  clearOAuthState(): void;
}
//#endregion
export {
	CookieAttributes,
	CookieInstruction,
	CookieSameSite,
	CookieWriter,
	HostPrefixedCookieName,
};

## core/http/environment.d.mts

import { CallerResolver } from "./caller.mjs";
import { CookieSameSite, HostPrefixedCookieName } from "./cookies.mjs";
import { RateLimiter } from "./rate-limit.mjs";
import { FrozenContext } from "../plugin/config.mjs";
import { AnyRoute, RouteMetadata } from "./route.mjs";

//#region src/core/http/environment.d.ts
interface Clock {
  now(): Date;
}
type LogLevel = "error" | "info" | "warn";
interface HttpEnvironment {
  readonly callers: CallerResolver;
  readonly clock: Clock;
  readonly cookieSameSite: CookieSameSite;
  readonly freshnessWindowInSeconds: number;
  readonly log: (level: LogLevel, message: string, fields?: Readonly<Record<string, unknown>>) => void;
  readonly origins: readonly string[];
  /** the frozen context a route's handler gets, the core one for a route nobody registered */
  readonly pluginContextOf: (route: RouteMetadata) => FrozenContext;
  readonly rateLimiter: RateLimiter;
  readonly routes: readonly AnyRoute[];
  readonly sessionCookieMaximumAgeInSeconds: number;
  readonly sessionCookieName: HostPrefixedCookieName;
  /** CIDR ranges whose `X-Forwarded-For` counts, and when empty the connection address does */
  readonly trustedProxies: readonly string[];
}
interface WebHandlerTarget {
  readonly http: HttpEnvironment;
}
//#endregion
export {
	Clock,
	HttpEnvironment,
	WebHandlerTarget,
};

## core/http/error-map.d.mts

//#region src/core/http/error-map.d.ts
type VelveErrorCode = "account_disabled" | "factor_already_enrolled" | "factor_not_enrolled" | "freshness_required" | "identity_already_linked" | "internal_error" | "invalid_credentials" | "invalid_factor_code" | "invalid_input" | "invalid_pending_authentication" | "invalid_recovery_code" | "invalid_token" | "last_sign_in_method" | "oauth_flow_invalid" | "oauth_provider_error" | "origin_not_allowed" | "password_unacceptable" | "provider_not_configured" | "rate_limited" | "session_required" | "too_many_factor_attempts" | "username_invalid" | "username_taken" | "webauthn_challenge_invalid" | "webauthn_credential_rejected";
/** an error code a plugin contributes, which begins with that plugin's id */
type PluginErrorCode = `${string}.${string}`;
type AnyErrorCode = VelveErrorCode | PluginErrorCode;
interface PluginErrorDefinition {
  readonly httpStatus: number;
  readonly message: string;
}
/** registers a plugin's error codes, refusing a code already registered with another answer */
declare function registerPluginErrorCodes(definitions: Readonly<Record<PluginErrorCode, PluginErrorDefinition>>): void;
/** answers any error code, a core one from the core tables and a plugin one from the registry */
declare function resolveErrorCode(code: AnyErrorCode): PluginErrorDefinition;
declare class VelveError extends Error {
  readonly code: AnyErrorCode;
  readonly httpStatus: number;
  readonly retryAfterSeconds?: number;
  constructor(code: AnyErrorCode, options?: {
    readonly retryAfterSeconds: number;
  });
}
//#endregion
export {
	AnyErrorCode,
	PluginErrorCode,
	PluginErrorDefinition,
	VelveError,
	VelveErrorCode,
	registerPluginErrorCodes,
	resolveErrorCode,
};

## core/http/rate-limit.d.mts

//#region src/core/http/rate-limit.d.ts
interface BucketRule {
  readonly capacity: number;
  readonly refillPerSecond: number;
}
interface RateLimitRule {
  readonly perAccount: BucketRule | "none";
  readonly perIpAddress: BucketRule | "none";
}
type RateLimitScope = {
  readonly ipAddress: string | null;
  readonly kind: "ip_address";
} | {
  readonly accountIdentifier: string;
  readonly kind: "account";
};
interface RateLimitRequest {
  readonly routeName: string;
  readonly rule: BucketRule;
  readonly scope: RateLimitScope;
}
interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds?: number;
}
interface RateLimiter {
  consume(request: RateLimitRequest): Promise<RateLimitDecision>;
}
//#endregion
export {
	BucketRule,
	RateLimitRule,
	RateLimiter,
};

## core/http/redirect.d.mts

//#region src/core/http/redirect.d.ts
type RedirectPath = string & {
  readonly __brand: "RedirectPath";
};
//#endregion
export {
	RedirectPath,
};

## core/http/route.d.mts

import { ResolvedPendingAuthentication, Session } from "./caller.mjs";
import { CookieWriter } from "./cookies.mjs";
import { RateLimitRule } from "./rate-limit.mjs";
import { AnyErrorCode } from "./error-map.mjs";
import { FrozenContext } from "../plugin/config.mjs";
import { ObjectValidator } from "./validators.mjs";

//#region src/core/http/route.d.ts
type HttpMethod = "GET" | "POST";
type CallerRequirement = "anonymous" | "pending" | "server_only" | "session";
type FreshnessRequirement = "not_required" | "required";
type OriginRequirement = "checked" | "exempt";
/** whether a route may read the pending cookie without being authorised by it */
type PendingCookieAccess = "hidden" | "readable";
/** whether a route may read the OAuth state cookie, which authorises nothing on its own */
type OAuthStateCookieAccess = "hidden" | "readable";
/** how a POST body arrives, where `form` serves only a provider's `form_post` callback */
type RequestBodyFormat = "form" | "json";
interface RequestContext {
  readonly cookies: CookieWriter;
  readonly ipAddress: string | null;
  readonly oauthStateToken: string | null;
  readonly pending: ResolvedPendingAuthentication | null;
  readonly pendingToken: string | null;
  /** the frozen plugin context, which for a core route carries no tables of its own */
  readonly plugin: FrozenContext;
  readonly session: Session | null;
  readonly sessionToken: string | null;
  readonly userAgent: string | null;
  enforceAccountRateLimit(normalisedIdentifier: string): Promise<void>;
}
interface RouteDeclaration<Name extends string, Path extends string, Input$1, Output$1, Code extends AnyErrorCode> {
  readonly caller: CallerRequirement;
  readonly errors: readonly Code[];
  readonly freshness: FreshnessRequirement;
  readonly handler: (input: Input$1, context: RequestContext) => Promise<Output$1>;
  readonly input: ObjectValidator<Input$1>;
  readonly method: HttpMethod;
  readonly name: Name;
  /** absent means hidden, and no caller requirement implies it, so a route reading it says so */
  readonly oauthStateCookie?: OAuthStateCookieAccess;
  readonly originCheck: OriginRequirement;
  readonly path: Path;
  /** absent means hidden, and a pending caller implies readable and may not say otherwise */
  readonly pendingCookie?: PendingCookieAccess;
  readonly rateLimit: RateLimitRule;
  /** absent means JSON, which every route the application itself calls sends */
  readonly requestBody?: RequestBodyFormat;
}
interface RouteMetadata {
  readonly caller: CallerRequirement;
  readonly errors: readonly AnyErrorCode[];
  readonly freshness: FreshnessRequirement;
  readonly method: HttpMethod;
  readonly name: string;
  readonly oauthStateCookie: OAuthStateCookieAccess;
  readonly originCheck: OriginRequirement;
  readonly path: string;
  readonly pendingCookie: PendingCookieAccess;
  readonly rateLimit: RateLimitRule;
  readonly requestBody: RequestBodyFormat;
}
declare const routeOutput: unique symbol;
/** a route typed by a phantom property, with no member that runs it even under `Reflect.ownKeys` */
interface RunnableRoute<Output$1> extends RouteMetadata {
  readonly [routeOutput]?: Output$1;
}
type AnyRoute = RunnableRoute<unknown>;
/** a built route, which carries no handler, so no caller holding it can reach past the checks */
interface Route<Name extends string, Path extends string, Input$1, Output$1, Code extends AnyErrorCode> extends RouteMetadata, RunnableRoute<Output$1> {
  readonly errors: readonly Code[];
  readonly input: ObjectValidator<Input$1>;
  readonly name: Name;
  readonly path: Path;
}
interface ServerCallFields {
  readonly ipAddress?: string | null;
  readonly oauthStateToken?: string;
  readonly origin: string | null;
  readonly pendingToken?: string;
  readonly sessionToken?: string;
  readonly userAgent?: string | null;
}
type ServerMethodOf<R> = R extends Route<string, string, infer Input, infer Output, AnyErrorCode> ? (input: Input & ServerCallFields) => Promise<Output> : never;
type Nest<Name extends string, Method> = Name extends `${infer Head}.${infer Rest}` ? { [Key in Head]: Nest<Rest, Method> } : { [Key in Name]: Method };
type UnionToIntersection<Union> = (Union extends unknown ? (argument: Union) => void : never) extends ((argument: infer Intersection) => void) ? Intersection : never;
type ServerSurface<Routes extends readonly AnyRoute[]> = UnionToIntersection<{ [Index in keyof Routes]: Nest<Routes[Index]["name"], ServerMethodOf<Routes[Index]>> }[number]>;
//#endregion
export {
	AnyRoute,
	CallerRequirement,
	HttpMethod,
	Nest,
	OriginRequirement,
	Route,
	RouteDeclaration,
	RouteMetadata,
	ServerCallFields,
	ServerSurface,
	UnionToIntersection,
};

## core/http/validators.d.mts

//#region src/core/http/validators.d.ts
interface Validator<T$1> {
  parse(raw: unknown): T$1;
}
interface ObjectValidator<T$1> extends Validator<T$1> {
  readonly fields: readonly string[];
}
//#endregion
export {
	ObjectValidator,
};

## core/http/web-handler.d.mts

import { WebHandlerTarget } from "./environment.mjs";

//#region src/core/http/web-handler.d.ts
interface WebHandlerOptions {
  readonly basePath?: string;
  /** the address the connection came from, which the adapter supplies as a `Request` lacks it */
  readonly connectionAddress?: (request: Request) => string | null;
}
declare function toWebHandler(auth: WebHandlerTarget, options?: WebHandlerOptions): (request: Request) => Promise<Response>;
//#endregion
export {
	WebHandlerOptions,
	toWebHandler,
};

## core/identity/configuration.d.mts

import { IdentityMode } from "../db/migrations/identity-mode.mjs";

//#region src/core/identity/configuration.d.ts
interface UsernameRules {
  readonly allowedCharacters: RegExp;
  readonly maximumLength: number;
  readonly minimumLength: number;
  readonly reservedNames: readonly string[];
}
interface EmailIdentity {
  readonly mode: "email";
  readonly username?: never;
}
interface UsernameIdentity {
  readonly mode: "username";
  readonly username: UsernameRules;
}
interface UsernameAndEmailIdentity {
  readonly mode: "username_email";
  readonly username: UsernameRules;
}
interface IdentityByMode {
  readonly email: EmailIdentity;
  readonly username: UsernameIdentity;
  readonly username_email: UsernameAndEmailIdentity;
}
type IdentityConfiguration<Mode extends IdentityMode = IdentityMode> = IdentityByMode[Mode];
interface IdentityInputByMode {
  readonly email: {
    readonly mode: "email";
    readonly username?: never;
  };
  readonly username: {
    readonly mode: "username";
    readonly username?: Partial<UsernameRules>;
  };
  readonly username_email: {
    readonly mode: "username_email";
    readonly username?: Partial<UsernameRules>;
  };
}
type IdentityConfigurationInput<Mode extends IdentityMode = IdentityMode> = IdentityInputByMode[Mode];
//#endregion
export {
	IdentityConfiguration,
	IdentityConfigurationInput,
	UsernameRules,
};

## core/keys/provider.d.mts

import { KeyPurpose } from "./purpose.mjs";

//#region src/core/keys/provider.d.ts
interface KeyProvider {
  current(purpose: KeyPurpose): Promise<{
    key: CryptoKey;
    version: number;
  }>;
  byVersion(purpose: KeyPurpose, version: number): Promise<CryptoKey | null>;
}
//#endregion
export {
	KeyProvider,
};

## core/keys/purpose.d.mts

//#region src/core/keys/purpose.d.ts
declare const KEY_PURPOSES: readonly ["cookie-sig", "token-pepper", "totp-enc", "oauth-token-enc", "pkce-enc", "password-enc"];
type KeyPurpose = (typeof KEY_PURPOSES)[number];
//#endregion
export {
	KeyPurpose,
};

## core/keys/root-key-provider.d.mts

import { KeyProvider } from "./provider.mjs";

//#region src/core/keys/root-key-provider.d.ts
interface RootKeyProviderInput {
  currentVersion: number;
  keysByVersion: Readonly<Record<number, string>>;
}
declare function rootKeyProvider(input: RootKeyProviderInput): KeyProvider;
//#endregion
export {
	rootKeyProvider,
};

## core/oauth/claims.d.mts

//#region src/core/oauth/claims.d.ts
/** what one provider says about one account, where `emailVerified` never links on its own */
interface ProviderAccount {
  readonly claims: Record<string, unknown>;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly subject: string;
}
//#endregion
export {
	ProviderAccount,
};

## core/oauth/config.d.mts

import { ProviderAccount } from "./claims.mjs";

//#region src/core/oauth/config.d.ts
/** the fourteen built-in providers, every other provider being generic */
type KnownProvider = "apple" | "discord" | "dropbox" | "facebook" | "github" | "gitlab" | "google" | "linkedin" | "microsoft" | "notion" | "slack" | "spotify" | "twitch" | "zoom";
/** the four prompt values the authorization request may carry, and no free-form string */
type OAuthPrompt = "consent" | "login" | "none" | "select_account";
/** how the provider answers, where Apple requires `form_post` once the email scope is asked for */
type OAuthResponseMode = "form_post" | "query";
interface ProviderCredentials {
  /** for a self-hosted built-in provider whose endpoints live on another host */
  readonly authorizationEndpoint?: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly issuer?: string;
  readonly jwksUri?: string;
  readonly prompt?: OAuthPrompt;
  /** absent means `${callbackBaseUrl}/${provider}`, where the callback route answers */
  readonly redirectUri?: string;
  readonly responseMode?: OAuthResponseMode;
  readonly scopes?: readonly string[];
  readonly tokenEndpoint?: string;
  readonly userInfoEndpoint?: string;
}
/** a generic provider, whose `subjectClaim` has no default and reaches nested claims by dots */
interface GenericProviderConfig extends ProviderCredentials {
  readonly authorizationEndpoint: string;
  readonly emailClaim?: string;
  readonly emailVerifiedClaim?: string;
  readonly subjectClaim: string;
  readonly tokenEndpoint: string;
}
/** the OAuth configuration, where a known provider may be given credentials alone */
interface OAuthConfig {
  readonly providers: Partial<Record<KnownProvider, ProviderCredentials>> & {
    readonly [customId: string]: ProviderCredentials | GenericProviderConfig;
  };
  /** the absolute callback URL the provider id is appended to, never derived from a request */
  readonly callbackBaseUrl: string;
  /** supplies the identifiers a provider cannot for a new account, never its email address */
  readonly identifiersForNewAccount?: (input: NewAccountInput) => Promise<NewAccountIdentifiers> | NewAccountIdentifiers;
  /** off by default, so omitting it stores no provider token */
  readonly storeTokens?: boolean;
  /** the providers trusted for an automatic link, one of the three conditions it requires */
  readonly trustedProviders: readonly string[];
}
/** what the application is told about the person it is being asked to name */
interface NewAccountInput {
  readonly account: ProviderAccount;
  readonly provider: string;
}
interface NewAccountIdentifiers {
  readonly username?: string;
}
//#endregion
export {
	GenericProviderConfig,
	KnownProvider,
	OAuthConfig,
	OAuthPrompt,
	OAuthResponseMode,
	ProviderCredentials,
};

## core/oauth/routes.d.mts

import { IdentityMode } from "../db/migrations/identity-mode.mjs";
import { Route, ServerSurface } from "../http/route.mjs";
import { RouteServices } from "../auth/routes.mjs";
import { Identity, OAuthRedirect } from "../auth/results.mjs";
import { OAuthCallbackOutcome } from "./service.mjs";

//#region src/core/oauth/routes.d.ts
/** the third-party sign-in and identity routes, typed so their names reach the instance */
declare function oauthRoutes(services: RouteServices): readonly [Route<"signIn.oauth.start", "/sign-in/oauth/start", {
  provider: string;
} & {
  redirectPath?: string;
}, OAuthRedirect, "invalid_input" | "origin_not_allowed" | "provider_not_configured" | "rate_limited">, Route<"signIn.oauth.callback", "/sign-in/oauth/callback/:provider", {
  code: string;
  provider: string;
  state: string;
} & {
  iss?: string;
}, OAuthCallbackOutcome, "identity_already_linked" | "invalid_input" | "oauth_flow_invalid" | "oauth_provider_error" | "rate_limited">, Route<"signIn.oauth.callbackFormPost", "/sign-in/oauth/callback/:provider", {
  code: string;
  provider: string;
  state: string;
} & {
  iss?: string;
}, OAuthCallbackOutcome, "identity_already_linked" | "invalid_input" | "oauth_flow_invalid" | "oauth_provider_error" | "rate_limited">, Route<"identity.list", "/identity/list", {} & {}, Identity[], "account_disabled" | "origin_not_allowed" | "rate_limited" | "session_required">, Route<"identity.link.start", "/identity/link/start", {
  provider: string;
} & {
  redirectPath?: string;
}, OAuthRedirect, "account_disabled" | "freshness_required" | "invalid_input" | "origin_not_allowed" | "provider_not_configured" | "rate_limited" | "session_required">, Route<"identity.unlink", "/identity/unlink", {
  identityId: string;
} & {}, void, "account_disabled" | "freshness_required" | "invalid_input" | "last_sign_in_method" | "origin_not_allowed" | "rate_limited" | "session_required">];
/** the OAuth namespaces this feature adds to the instance, per identity mode */
type OAuthSurface<M extends IdentityMode> = M extends IdentityMode ? ServerSurface<ReturnType<typeof oauthRoutes>> : never;
//#endregion
export {
	OAuthSurface,
	oauthRoutes,
};

## core/oauth/service.d.mts

import { OAuthCallbackResult } from "../auth/results.mjs";
import { RedirectPath } from "../http/redirect.mjs";

//#region src/core/oauth/service.d.ts

/** a callback result plus the path its redirect carries, the only `Location` the library emits */
type OAuthCallbackOutcome = OAuthCallbackResult & {
  readonly redirectToPath: RedirectPath;
};
//#endregion
export {
	OAuthCallbackOutcome,
};

## core/password/config.d.mts

import { LegacyScheme } from "./scheme.mjs";

//#region src/core/password/config.d.ts
interface Argon2idParameters {
  readonly iterations: number;
  readonly memoryKiB: number;
  readonly parallelism: number;
}
interface PasswordPolicy {
  readonly maximumLengthInBytes: number;
  readonly minimumLength: number;
}
interface PasswordConfig {
  readonly acceptLegacy?: readonly LegacyScheme[];
  readonly argon2id?: Argon2idParameters;
  readonly concurrentHashLimit?: number;
  readonly maximumLengthInBytes?: number;
  readonly minimumLength?: number;
  /** runs on the NFKC form when a password is set or changed, never at sign-in */
  readonly validate?: (plaintext: string) => Promise<void>;
}
interface ResolvedPasswordConfig extends PasswordPolicy {
  readonly acceptLegacy: ReadonlySet<LegacyScheme>;
  readonly argon2id: Argon2idParameters;
  readonly concurrentHashLimit: number;
  readonly validate?: (plaintext: string) => Promise<void>;
}
//#endregion
export {
	PasswordConfig,
	ResolvedPasswordConfig,
};

## core/password/routes.d.mts

import { IdentityMode } from "../db/migrations/identity-mode.mjs";
import { Route, ServerCallFields } from "../http/route.mjs";
import { SignInLookup } from "../auth/config.mjs";
import { RouteServices } from "../auth/routes.mjs";
import { SignInResult } from "../auth/results.mjs";
import { SetPasswordResult } from "../flows/results.mjs";

//#region src/core/password/routes.d.ts
interface SignInPasswordNamespace<M extends IdentityMode> {
  password(input: SignInLookup<M> & {
    password: string;
  } & ServerCallFields): Promise<SignInResult>;
}
/** setting and changing the PHC credential of the signed-in account */
interface SetPasswordNamespace {
  set(input: {
    newPassword: string;
  } & ServerCallFields): Promise<SetPasswordResult>;
  change(input: {
    currentPassword: string;
    newPassword: string;
  } & ServerCallFields): Promise<SetPasswordResult>;
}
type PasswordSurface<M extends IdentityMode> = {
  readonly password: SetPasswordNamespace;
  readonly signIn: SignInPasswordNamespace<M>;
};
/** the password routes, signing in and the two ways a session writes its PHC credential */
declare function passwordRoutes(services: RouteServices): readonly [Route<"signIn.password", "/sign-in/password", {
  email: string;
  emailOrUsername: string;
  password: string;
  username: string;
} & {}, SignInResult, "invalid_credentials" | "invalid_input" | "origin_not_allowed" | "rate_limited">, Route<"password.set", "/password/set", {
  newPassword: string;
} & {}, SetPasswordResult, "account_disabled" | "factor_already_enrolled" | "freshness_required" | "invalid_input" | "origin_not_allowed" | "password_unacceptable" | "rate_limited" | "session_required">, Route<"password.change", "/password/change", {
  currentPassword: string;
  newPassword: string;
} & {}, SetPasswordResult, "account_disabled" | "freshness_required" | "invalid_credentials" | "invalid_input" | "origin_not_allowed" | "password_unacceptable" | "rate_limited" | "session_required">];
//#endregion
export {
	PasswordSurface,
	passwordRoutes,
};

## core/password/scheme.d.mts

//#region src/core/password/scheme.d.ts
declare const LEGACY_SCHEMES: readonly ["argon2i", "argon2d", "bcrypt", "scrypt", "pbkdf2-sha256", "pbkdf2-sha512", "fbscrypt"];
type LegacyScheme = (typeof LEGACY_SCHEMES)[number];
//#endregion
export {
	LegacyScheme,
};

## core/password/semaphore.d.mts

//#region src/core/password/semaphore.d.ts

interface KdfSemaphore {
  run<T>(work: () => Promise<T>): Promise<T>;
  readonly inFlight: number;
  readonly peakInFlight: number;
  readonly waiting: number;
}
//#endregion
export {
	KdfSemaphore,
};

## core/plugin/config.d.mts

import { User } from "../auth/user.mjs";
import { IdentityMode } from "../db/migrations/identity-mode.mjs";
import { AuthenticationFactor, Session } from "../http/caller.mjs";
import { RateLimitRule } from "../http/rate-limit.mjs";
import { Clock } from "../http/environment.mjs";
import { VelveErrorCode } from "../http/error-map.mjs";
import { RouteDeclaration } from "../http/route.mjs";

//#region src/core/plugin/config.d.ts
type RevokeReason = "email_verified" | "identity_linked" | "password_changed" | "password_reset" | "revoked_by_user" | "sign_out";
interface SignInEvent {
  readonly ipAddress: string | null;
  readonly method: "magic_link" | "oauth" | "passkey" | "password";
  readonly userAgent: string | null;
  readonly userId: string | null;
}
interface SignInCompletedEvent extends SignInEvent {
  readonly factors: readonly AuthenticationFactor[];
  readonly sessionId: string;
  readonly signCountRegressed?: boolean;
  readonly userId: string;
}
interface SessionCreateEvent {
  readonly factors: readonly AuthenticationFactor[];
  readonly userId: string;
}
interface SessionCreatedEvent extends SessionCreateEvent {
  readonly sessionId: string;
}
interface UserCreateEvent {
  readonly email: string | null;
  readonly username: string | null;
}
interface UserCreatedEvent extends UserCreateEvent {
  readonly userId: string;
}
interface SessionRevokeEvent {
  readonly reason: RevokeReason;
  readonly sessionId: string;
  readonly userId: string;
}
interface PluginActor {
  readonly pluginId: string;
  readonly reason: string;
}
/** no writing method on `user`, `password_credential`, `totp_credential` or `recovery_code` */
interface FrozenRepositories {
  findUserById(input: {
    actor: PluginActor;
    userId: string;
  }): Promise<User | null>;
  listSessionsForUser(input: {
    actor: PluginActor;
    userId: string;
  }): Promise<Session[]>;
  revokeSession(input: {
    actor: PluginActor;
    reason: RevokeReason;
    sessionId: string;
  }): Promise<void>;
}
interface FrozenContext {
  readonly clock: Clock;
  readonly identityMode: IdentityMode;
  readonly repositories: FrozenRepositories;
  readonly schema: string;
  readonly ownTables: {
    query<Row>(sql: string, params: readonly unknown[]): Promise<Row[]>;
  };
  log(level: "error" | "info" | "warn", message: string, fields?: Readonly<Record<string, unknown>>): void;
}
/** the seven hook points, where a hook refuses by throwing and cannot replace the response */
interface PluginHooks {
  afterSessionCreate?: (event: SessionCreatedEvent, context: FrozenContext) => Promise<void>;
  afterSignIn?: (event: SignInCompletedEvent, context: FrozenContext) => Promise<void>;
  afterUserCreate?: (event: UserCreatedEvent, context: FrozenContext) => Promise<void>;
  beforeSessionCreate?: (event: SessionCreateEvent, context: FrozenContext) => Promise<void>;
  beforeSessionRevoke?: (event: SessionRevokeEvent, context: FrozenContext) => Promise<void>;
  beforeSignIn?: (event: SignInEvent, context: FrozenContext) => Promise<void>;
  beforeUserCreate?: (event: UserCreateEvent, context: FrozenContext) => Promise<void>;
}
interface PluginMigration<Id extends string> {
  readonly createsTables: readonly `${Id}_${string}`[];
  readonly name: string;
  readonly sql: string;
  readonly version: number;
}
/** who may call a plugin route, which never sees the pending or the OAuth state cookie */
type PluginCallerRequirement = "anonymous" | "server_only" | "session";
/** a route a plugin declares, with its own error codes and no exemption from the origin check */
type PluginRoute<Id extends string> = Omit<RouteDeclaration<`${Id}.${string}`, `/x/${Id}/${string}`, unknown, unknown, VelveErrorCode | `${Id}.${string}`>, "caller" | "oauthStateCookie" | "originCheck" | "pendingCookie" | "requestBody"> & {
  readonly caller: PluginCallerRequirement;
  readonly originCheck: "checked";
};
/** a plugin, whose declaration type cannot overwrite a core route */
interface VelvePlugin<Id extends string = string> {
  readonly dependsOn?: readonly string[];
  readonly errorCodes?: readonly `${Id}.${string}`[];
  readonly hooks?: PluginHooks;
  readonly id: Id;
  readonly migrations?: readonly PluginMigration<Id>[];
  readonly rateLimitRules?: Readonly<Record<`${Id}.${string}`, RateLimitRule>>;
  readonly routes?: readonly PluginRoute<Id>[];
}
//#endregion
export {
	FrozenContext,
	FrozenRepositories,
	PluginActor,
	PluginHooks,
	PluginMigration,
	PluginRoute,
	RevokeReason,
	SessionCreateEvent,
	SessionCreatedEvent,
	SessionRevokeEvent,
	SignInCompletedEvent,
	SignInEvent,
	UserCreateEvent,
	UserCreatedEvent,
	VelvePlugin,
};

## core/plugin/registry.d.mts

import { Driver } from "../db/driver.mjs";
import { OwnedMigration } from "../db/migration.mjs";
import { PluginErrorCode } from "../http/error-map.mjs";
import { FrozenContext, PluginHooks, SessionCreateEvent, SessionCreatedEvent, SessionRevokeEvent, SignInCompletedEvent, SignInEvent, UserCreateEvent, UserCreatedEvent, VelvePlugin } from "./config.mjs";
import { AnyRoute, RouteMetadata } from "../http/route.mjs";

//#region src/core/plugin/registry.d.ts
/** runs each hook point over every plugin in dependency order, a hook refusing by throwing */
interface PluginHookDispatcher {
  beforeSignIn(event: SignInEvent): Promise<void>;
  afterSignIn(event: SignInCompletedEvent): Promise<void>;
  beforeSessionCreate(event: SessionCreateEvent): Promise<void>;
  afterSessionCreate(event: SessionCreatedEvent): Promise<void>;
  beforeUserCreate(event: UserCreateEvent): Promise<void>;
  afterUserCreate(event: UserCreatedEvent): Promise<void>;
  /** a `transaction` runs every hook on that transaction's connection and not on the pool's */
  beforeSessionRevoke(event: SessionRevokeEvent, transaction?: Driver): Promise<void>;
}
interface PluginRuntime {
  /** the error codes every configured plugin declares */
  readonly declaredErrorCodes: readonly PluginErrorCode[];
  readonly hooks: PluginHookDispatcher;
  /** each plugin's migrations, run in dependency order under its own id */
  readonly migrations: readonly OwnedMigration[];
  /** the configured plugins in dependency order, the order every hook point runs them in */
  readonly plugins: readonly VelvePlugin[];
  readonly routes: readonly AnyRoute[];
  contextOf(route: RouteMetadata): FrozenContext;
  /** which plugin contributed a route */
  ownerOf(route: RouteMetadata): string;
  /** whether any plugin listens at a point, to skip building an event nobody hears */
  listensTo(point: keyof PluginHooks): boolean;
}
//#endregion
export {
	PluginRuntime,
};

## core/plugin/routes.d.mts

import { IdentityMode } from "../db/migrations/identity-mode.mjs";

//#region src/core/plugin/routes.d.ts

/** adds nothing to `VelveAuth<M>`, as a plugin's routes exist only on the object */
type PluginSurface<M extends IdentityMode> = M extends IdentityMode ? Record<never, never> : never;
//#endregion
export {
	PluginSurface,
};

## core/session/config.d.mts

import { CookieSameSite, HostPrefixedCookieName } from "../http/cookies.mjs";
import { Duration } from "./duration.mjs";

//#region src/core/session/config.d.ts
interface SessionConfig {
  readonly absoluteTimeout: Duration;
  readonly cookieName: HostPrefixedCookieName;
  readonly freshnessWindow: Duration;
  readonly idleTimeout: Duration;
  readonly idleWriteInterval: Duration;
  readonly cookie: {
    readonly sameSite: CookieSameSite;
  };
}
interface SessionSettings {
  readonly absoluteTimeoutMs: number;
  readonly cookieMaximumAgeInSeconds: number;
  readonly cookieName: HostPrefixedCookieName;
  readonly freshnessWindowMs: number;
  readonly idleTimeoutMs: number;
  readonly idleWriteIntervalMs: number;
  readonly sameSite: CookieSameSite;
}
//#endregion
export {
	SessionConfig,
	SessionSettings,
};

## core/session/duration.d.mts

//#region src/core/session/duration.d.ts
type Duration = `${number}${"d" | "h" | "m" | "s"}`;
//#endregion
export {
	Duration,
};

## core/session/metadata.d.mts

//#region src/core/session/metadata.d.ts
type SessionMetadataMode = "full" | "none" | "truncated";
//#endregion
export {
	SessionMetadataMode,
};

## core/session/service.d.mts

import { Actor, ResolvedSession } from "../db/actor.mjs";
import { Driver } from "../db/driver.mjs";
import { AuthenticationFactor, Session } from "../http/caller.mjs";
import { SessionSettings } from "./config.mjs";
import { SessionToken } from "./token.mjs";

//#region src/core/session/service.d.ts
/** the only proof of a resolved session the library accepts, produced by `resolve` alone */
type SessionResolution = ResolvedSession & {
  /** the database clock when it answered, the only clock freshness is decided by */
  readonly observedAt: Date;
  readonly session: Session;
};
interface IssuedSession {
  readonly session: Session;
  readonly token: SessionToken;
}
interface ObservedRequest {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}
interface SessionService {
  readonly settings: SessionSettings;
  /** the same service over another driver, for a session written in a caller's own transaction */
  boundTo(driver: Driver): SessionService;
  issue(input: {
    readonly factors: readonly AuthenticationFactor[];
    readonly observed: ObservedRequest;
    readonly userId: string;
  }): Promise<IssuedSession>;
  /** issues a session and removes the one the browser presented, whoever owns it, in one transaction */
  issueReplacingPresented(input: {
    readonly factors: readonly AuthenticationFactor[];
    readonly observed: ObservedRequest;
    readonly presentedToken: string | null;
    readonly userId: string;
  }): Promise<IssuedSession>;
  reissue(input: {
    readonly factors: readonly AuthenticationFactor[];
    readonly observed: ObservedRequest;
    readonly previousToken: string;
    readonly userId: string;
  }): Promise<IssuedSession>;
  reissueAfterCredentialChange(input: {
    readonly factors: readonly AuthenticationFactor[];
    readonly observed: ObservedRequest;
    readonly resolved: SessionResolution;
  }): Promise<IssuedSession>;
  /** replaces the one named session and leaves every other session of the account alone */
  reissueSessionOfUser(input: {
    readonly actor: Actor;
    readonly factors: readonly AuthenticationFactor[];
    readonly observed: ObservedRequest;
    readonly previousSessionId: string;
  }): Promise<IssuedSession>;
  resolve(token: string): Promise<SessionResolution | null>;
  refresh(token: string): Promise<SessionResolution | null>;
  signOut(input: {
    readonly token: string;
  }): Promise<void>;
  list(input: {
    readonly resolved: SessionResolution;
  }): Promise<Session[]>;
  revoke(input: {
    readonly resolved: SessionResolution;
    readonly targetSessionId: string;
  }): Promise<void>;
  revokeEveryOther(input: {
    readonly resolved: SessionResolution;
  }): Promise<{
    revokedCount: number;
  }>;
  revokeEvery(input: {
    readonly resolved: SessionResolution;
  }): Promise<{
    revokedCount: number;
  }>;
  revokeEverySessionOfUser(input: {
    readonly actor: Actor;
  }): Promise<{
    revokedCount: number;
  }>;
  /** the ids a revocation is about to remove, for telling a hook about exactly those rows */
  listEveryIdOwnedBy(input: {
    readonly resolved: SessionResolution;
  }): Promise<string[]>;
}
//#endregion
export {
	IssuedSession,
	ObservedRequest,
	SessionResolution,
	SessionService,
};

## core/session/token.d.mts

//#region src/core/session/token.d.ts
type SessionToken = string & {
  readonly __brand: "SessionToken";
};
//#endregion
export {
	SessionToken,
};

## core/token/one-time-token.d.mts

import { RedeemedOneTimeToken } from "../db/actor.mjs";
import { OneTimeTokenPayload, OneTimeTokenPurpose, OneTimeTokenSubject } from "./purpose.mjs";
import { SecretToken } from "./secret-token.mjs";

//#region src/core/token/one-time-token.d.ts
/** a `userId` of null asks for the cover artefact an address naming no account is answered with */
type OneTimeTokenRequest = {
  readonly payload?: OneTimeTokenPayload;
  readonly purpose: OneTimeTokenPurpose;
} & OneTimeTokenSubject;
interface IssuedOneTimeToken {
  readonly expiresAt: Date;
  readonly token: SecretToken;
}
/** a redeemed token carrying the proof of ownership its removal produced */
type OneTimeTokenRedemption = RedeemedOneTimeToken & {
  readonly payload: OneTimeTokenPayload | null;
  readonly purpose: OneTimeTokenPurpose;
};
interface OneTimeTokens {
  issue(request: OneTimeTokenRequest): Promise<IssuedOneTimeToken>;
  redeem(attempt: {
    purpose: OneTimeTokenPurpose;
    token: SecretToken;
  }): Promise<OneTimeTokenRedemption | null>;
}
//#endregion
export {
	OneTimeTokens,
};

## core/token/purpose.d.mts

//#region src/core/token/purpose.d.ts
declare const ONE_TIME_TOKEN_PURPOSES: readonly ["email_verify", "password_reset", "email_change", "magic_link"];
type OneTimeTokenPurpose = (typeof ONE_TIME_TOKEN_PURPOSES)[number];
type OneTimeTokenPayload = Readonly<Record<string, unknown>>;
/** who an artefact is for, and a request naming no account still says what it is about */
type OneTimeTokenSubject = {
  readonly serialisedOn?: undefined;
  readonly userId: string;
} | {
  readonly serialisedOn: string;
  readonly userId: null;
};
//#endregion
export {
	OneTimeTokenPayload,
	OneTimeTokenPurpose,
	OneTimeTokenSubject,
};

## core/token/secret-token.d.mts

//#region src/core/token/secret-token.d.ts
declare const secretTokenBrand: unique symbol;
type SecretToken = string & {
  readonly [secretTokenBrand]: "one-time token";
};
//#endregion
export {
	SecretToken,
};

## http.d.mts

import { WebHandlerOptions, toWebHandler } from "./core/http/web-handler.mjs";
export {
	type WebHandlerOptions,
	toWebHandler,
};

## import.d.mts

export {

};

## index.d.mts

import { EntityId, IdentityId, ProviderId, SessionId, UserId, WebAuthnCredentialId, toEntityId } from "./core/db/entity-id.mjs";
import { Actor, ConsumedOAuthFlow, RedeemedOneTimeToken, ResolvedSession, actorOfConsumedOAuthFlow, actorOfRedeemedOneTimeToken, actorOfResolvedSession } from "./core/db/actor.mjs";
import { ImportSource, User } from "./core/auth/user.mjs";
import { IdentityMode } from "./core/db/migrations/identity-mode.mjs";
import { AuthenticationFactor, PendingAuthentication, Session } from "./core/http/caller.mjs";
import { CookieAttributes, CookieInstruction } from "./core/http/cookies.mjs";
import { Clock } from "./core/http/environment.mjs";
import { AnyErrorCode, PluginErrorCode, PluginErrorDefinition, VelveError, VelveErrorCode, registerPluginErrorCodes, resolveErrorCode } from "./core/http/error-map.mjs";
import { FrozenContext, FrozenRepositories, PluginActor, PluginHooks, PluginMigration, PluginRoute, RevokeReason, SessionCreateEvent, SessionCreatedEvent, SessionRevokeEvent, SignInCompletedEvent, SignInEvent, UserCreateEvent, UserCreatedEvent, VelvePlugin } from "./core/plugin/config.mjs";
import { AnyRoute, CallerRequirement, OriginRequirement } from "./core/http/route.mjs";
import { SessionToken } from "./core/session/token.mjs";
import { PendingToken } from "./core/factor/pending/token.mjs";
import { UsernameRules } from "./core/identity/configuration.mjs";
import { KeyProvider } from "./core/keys/provider.mjs";
import { rootKeyProvider } from "./core/keys/root-key-provider.mjs";
import { GenericProviderConfig, KnownProvider, OAuthConfig, OAuthPrompt, OAuthResponseMode, ProviderCredentials } from "./core/oauth/config.mjs";
import { BaseConfig, EmailConfig, EmailMessage, IdentityConfig, IdentityFields, ModeHasEmail, ModeHasUsername, OnlyWhen, RateAlert, RateLimitConfig, RecoveryCodesConfig, RecoveryCodesRequirement, SignInLookup, TotpConfig, VelveAuthConfig, WebAuthnConfig } from "./core/auth/config.mjs";
import { ResolvedSessionView } from "./core/auth/routes.mjs";
import { Identity, OAuthCallbackResult, OAuthRedirect, SignInResult, SignUpResult } from "./core/auth/results.mjs";
import { TotpEnrollment } from "./core/factor/totp/secret.mjs";
import { WebAuthnCredential } from "./core/factor/webauthn/credential-repository.mjs";
import { WebAuthnAuthenticationChallenge, WebAuthnRegistrationChallenge } from "./core/factor/webauthn/service.mjs";
import { AuthenticatorResponse, RecoveryNamespace, SignInPasskeyNamespace, TotpNamespace, WebAuthnNamespace } from "./core/factor/routes.mjs";
import { ChangedUser, EmailNamespace, MagicLinkNamespace, MailedPasswordNamespace, RecoveryPasswordNamespace, SetPasswordResult, SignUpNamespace } from "./core/flows/results.mjs";
import { EmailFlowSurface } from "./core/flows/routes.mjs";
import { OAuthCallbackOutcome } from "./core/oauth/service.mjs";
import { SweepReport } from "./core/auth/maintenance.mjs";
import { ChosenWeakening, SECURITY_OPTIONS, SecurityOption } from "./core/auth/security-options.mjs";
import { AuthInternals, PendingNamespace, SessionNamespace, UserNamespace, UsernameNamespace, VelveAuth } from "./core/auth/instance.mjs";
import { RouteConflict, THE_CORE, VelveStartupError } from "./core/auth/startup.mjs";
import { TRUST_LEVEL_EVENTS, TRUST_LEVEL_EVENT_REVOKES_OTHER_SESSIONS, TrustLevelEvent } from "./core/auth/trust-level.mjs";
import { OwnedRowRepository, OwnedRowRepositoryOptions, UnknownColumnError, createOwnedRowRepository } from "./core/db/repositories/owned-row-repository.mjs";

//#region src/index.d.ts
declare function createVelveAuth<M extends IdentityMode>(config: VelveAuthConfig<M>): VelveAuth<M>;
declare const VELVE_AUTH_VERSION = "1.2.0";
//#endregion
export {
	type Actor,
	type AnyErrorCode,
	type AnyRoute,
	type AuthInternals,
	type AuthenticationFactor,
	type AuthenticatorResponse,
	type BaseConfig,
	type CallerRequirement,
	ChangedUser,
	type ChosenWeakening,
	type Clock,
	type ConsumedOAuthFlow,
	type CookieAttributes,
	type CookieInstruction,
	type EmailConfig,
	EmailFlowSurface,
	type EmailMessage,
	EmailNamespace,
	type EntityId,
	FrozenContext,
	FrozenRepositories,
	GenericProviderConfig,
	type Identity,
	type IdentityConfig,
	type IdentityFields,
	type IdentityId,
	type IdentityMode,
	type ImportSource,
	type KeyProvider,
	KnownProvider,
	MagicLinkNamespace,
	MailedPasswordNamespace,
	type ModeHasEmail,
	type ModeHasUsername,
	OAuthCallbackOutcome,
	type OAuthCallbackResult,
	OAuthConfig,
	OAuthPrompt,
	type OAuthRedirect,
	OAuthResponseMode,
	type OnlyWhen,
	type OriginRequirement,
	type OwnedRowRepository,
	type OwnedRowRepositoryOptions,
	type PendingAuthentication,
	type PendingNamespace,
	type PendingToken,
	PluginActor,
	type PluginErrorCode,
	type PluginErrorDefinition,
	PluginHooks,
	PluginMigration,
	PluginRoute,
	ProviderCredentials,
	type ProviderId,
	type RateAlert,
	type RateLimitConfig,
	type RecoveryCodesConfig,
	type RecoveryCodesRequirement,
	type RecoveryNamespace,
	RecoveryPasswordNamespace,
	type RedeemedOneTimeToken,
	type ResolvedSession,
	type ResolvedSessionView,
	RevokeReason,
	type RouteConflict,
	SECURITY_OPTIONS,
	type SecurityOption,
	type Session,
	SessionCreateEvent,
	SessionCreatedEvent,
	type SessionId,
	type SessionNamespace,
	SessionRevokeEvent,
	type SessionToken,
	SetPasswordResult,
	SignInCompletedEvent,
	SignInEvent,
	type SignInLookup,
	type SignInPasskeyNamespace,
	type SignInResult,
	SignUpNamespace,
	type SignUpResult,
	type SweepReport,
	THE_CORE,
	TRUST_LEVEL_EVENTS,
	TRUST_LEVEL_EVENT_REVOKES_OTHER_SESSIONS,
	type TotpConfig,
	type TotpEnrollment,
	type TotpNamespace,
	type TrustLevelEvent,
	UnknownColumnError,
	type User,
	UserCreateEvent,
	UserCreatedEvent,
	type UserId,
	type UserNamespace,
	type UsernameNamespace,
	type UsernameRules,
	VELVE_AUTH_VERSION,
	type VelveAuth,
	type VelveAuthConfig,
	VelveError,
	type VelveErrorCode,
	VelvePlugin,
	VelveStartupError,
	type WebAuthnAuthenticationChallenge,
	type WebAuthnConfig,
	type WebAuthnCredential,
	type WebAuthnCredentialId,
	type WebAuthnNamespace,
	type WebAuthnRegistrationChallenge,
	actorOfConsumedOAuthFlow,
	actorOfRedeemedOneTimeToken,
	actorOfResolvedSession,
	createOwnedRowRepository,
	createVelveAuth,
	registerPluginErrorCodes,
	resolveErrorCode,
	rootKeyProvider,
	toEntityId,
};

## neon.d.mts

export {

};

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
export {
	NodePostgresClient,
	NodePostgresPool,
	NodePostgresQueryConfig,
	NodePostgresResult,
	createNodePostgresDriver,
};

## postgres-js.d.mts

export {

};

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
export {
	type AppliedMigration,
	type Driver,
	type IdentityMode,
	InvalidIdentifierError,
	type Migration,
	MigrationRefusedError,
	type MigrationReport,
	type MigrationRunnerOptions,
	MissingCascadeError,
	type SchemaStatus,
	type SchemaStatusOptions,
	SchemaVersionMismatchError,
	UnrewritableMigrationError,
	assertSchemaUpToDate,
	coreMigrations,
	readSchemaStatus,
	runMigrations,
};

## testing.d.mts

import { Clock } from "./core/http/environment.mjs";

//#region src/testing/index.d.ts
/** the deterministic `clock` a test hands to the configuration */
interface TestClock extends Clock {
  set(instant: Date): void;
  advanceBy(milliseconds: number): void;
}
declare function createTestClock(start?: Date): TestClock;
//#endregion
export {
	TestClock,
	createTestClock,
};