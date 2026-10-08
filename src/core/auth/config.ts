import type { Driver } from "../db/driver.js";
import type { IdentityMode } from "../db/migrations/identity-mode.js";
import type { Clock } from "../http/environment.js";
import type { BucketRule } from "../http/rate-limit.js";
import type { IdentityConfigurationInput } from "../identity/configuration.js";
import type { KeyProvider } from "../keys/provider.js";
import type { OAuthConfig } from "../oauth/config.js";
import type { PasswordConfig } from "../password/config.js";
import type { VelvePlugin } from "../plugin/config.js";
import type { SessionConfig } from "../session/config.js";
import type { SessionMetadataMode } from "../session/metadata.js";

/** the identity fields each identity mode carries, one row per mode */
export interface IdentityFieldsByMode {
	email: { email: string };
	username: { username: string };
	username_email: { email: string; username: string };
}

export interface SignInLookupByMode {
	email: { email: string };
	username: { username: string };
	username_email: { emailOrUsername: string };
}

export type IdentityFields<M extends IdentityMode> = IdentityFieldsByMode[M];
export type SignInLookup<M extends IdentityMode> = SignInLookupByMode[M];

export type ModeHasEmail<M extends IdentityMode> = M extends "email" | "username_email"
	? true
	: false;
export type ModeHasUsername<M extends IdentityMode> = M extends "username" | "username_email"
	? true
	: false;

//a namespace the mode does not offer is removed, so the error names the mode
export type PresentKeys<Surface> = {
	[Key in keyof Surface]-?: [Surface[Key]] extends [never] ? never : Key;
}[keyof Surface];
export type Prune<Surface> = { [Key in PresentKeys<Surface>]: Surface[Key] };
export type OnlyWhen<Condition extends boolean, Surface> = Condition extends true ? Surface : never;

export interface RecoveryCodesConfig {
	readonly count: number;
	readonly groupSize: number;
}

export interface TotpConfig {
	readonly issuer: string;
	readonly stepToleranceInSteps: 0 | 1;
}

export interface WebAuthnConfig {
	readonly relyingPartyId: string;
	readonly relyingPartyName: string;
	readonly origins: readonly string[];
	readonly userVerification: "required" | "preferred";
}

/** four kinds answer the four one-time-token purposes and the last two are the enumeration cover */
export type EmailMessage =
	| { kind: "email_verification"; to: string; userId: string; token: string; expiresAt: Date }
	| { kind: "password_reset"; to: string; userId: string; token: string; expiresAt: Date }
	| {
			kind: "email_change";
			to: string;
			userId: string;
			token: string;
			expiresAt: Date;
			previousEmail: string;
	  }
	| { kind: "magic_link"; to: string; userId: string; token: string; expiresAt: Date }
	| { kind: "sign_up_attempt_on_existing_account"; to: string; userId: string }
	| { kind: "request_for_unknown_address"; to: string; requested: "password_reset" | "magic_link" };

export interface EmailConfig {
	send: (message: EmailMessage) => Promise<void>;
}

export interface RateAlert {
	readonly routeName: string;
	readonly requestsInLastMinute: number;
	readonly observedAt: Date;
}

export interface RateLimitConfig {
	readonly perIpAddress: BucketRule;
	readonly perAccount: BucketRule;
	readonly globalPerRoute: {
		readonly alertThresholdPerMinute: number;
		readonly onAlert: (alert: RateAlert) => void;
	};
}

/** whether every account must carry a seal, or the estate is still being sealed */
export interface SecurityStateConfig {
	readonly sealing: "required" | "migrating";
}

/** the identity options for mode `M`, where only a username mode carries the username rules */
export type IdentityConfig<M extends IdentityMode> = IdentityConfigurationInput & {
	readonly mode: M;
};

/** a username mode without recovery codes is a compile error as well as a start error */
export type RecoveryCodesRequirement<M extends IdentityMode> = M extends "username"
	? { recoveryCodes: RecoveryCodesConfig }
	: { recoveryCodes?: RecoveryCodesConfig };

export interface BaseConfig<M extends IdentityMode> {
	readonly database: Driver;
	readonly identity: IdentityConfig<M>;
	readonly keys: KeyProvider;
	readonly origins: readonly string[];
	readonly password?: PasswordConfig;
	readonly session?: Partial<SessionConfig>;
	readonly sessionMetadata?: SessionMetadataMode;
	readonly trustedProxies?: readonly string[];
	readonly rateLimit?: Partial<RateLimitConfig>;
	readonly email?: EmailConfig;
	readonly oauth?: OAuthConfig;
	/** the fetch used for outbound provider calls, `globalThis.fetch` when absent */
	readonly fetch?: typeof globalThis.fetch;
	readonly plugins?: readonly VelvePlugin[];
	/** the PostgreSQL role every plugin statement is switched to, holding rights on the plugins' own tables only */
	readonly pluginDatabaseRole?: string;
	/** a second connection that logs in as the plugin role, on which every plugin statement runs */
	readonly pluginDatabase?: Driver;
	readonly webauthn?: WebAuthnConfig;
	readonly totp?: Partial<TotpConfig>;
	readonly schema?: string;
	readonly clock?: Clock;
	readonly securityState?: SecurityStateConfig;
	readonly log?: (
		level: "info" | "warn" | "error",
		message: string,
		fields?: Readonly<Record<string, unknown>>,
	) => void;
}

export type VelveAuthConfig<M extends IdentityMode> = BaseConfig<M> & RecoveryCodesRequirement<M>;
