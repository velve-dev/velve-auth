import type { Driver } from "../db/driver.js";
import type { IdentityMode } from "../db/migrations/identity-mode.js";
import type { Clock } from "../http/environment.js";
import type { BucketRule } from "../http/rate-limit.js";
import type { IdentityConfigurationInput } from "../identity/configuration.js";
import type { KeyProvider } from "../keys/provider.js";
import type { PasswordConfig } from "../password/config.js";
import type { SessionConfig } from "../session/config.js";
import type { SessionMetadataMode } from "../session/metadata.js";

/**
 * Architecture 3.15 A.1: lookup tables rather than conditional types spread over the surface, so
 * that a reader sees one row per mode and never an `infer`.
 */
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

/** A.1, design B: a namespace the mode does not offer is removed, so the error names the mode. */
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

/** A.7: four kinds answer the four one-time-token purposes; the last two are the enumeration cover. */
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

/**
 * `mode` stands alone as `{ readonly mode: M }` because that is the only shape `M` can be inferred
 * from. Written as one conditional type — which is what it was — the whole type is a non-inferrable
 * position, `M` falls back to the union, `RecoveryCodesRequirement` distributes and its optional
 * branch swallows every configuration. The username rules come from `IdentityConfigurationInput`,
 * the lookup table `core/identity` already keeps, so the constraint that only a username mode
 * carries them has one definition rather than a second one here (E-349).
 */
export type IdentityConfig<M extends IdentityMode> = IdentityConfigurationInput & {
	readonly mode: M;
};

/**
 * S-DEFAULT-4 and E-207: 3.4 asks for a start error, and this makes it a compile error as well.
 * The condition is a statement about the instance options — it ties `identity.mode` to
 * `recoveryCodes` — which is why it could not be built in `core/identity`, where only the mode is
 * in view.
 */
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
	readonly webauthn?: WebAuthnConfig;
	readonly totp?: Partial<TotpConfig>;
	readonly schema?: string;
	readonly clock?: Clock;
	readonly log?: (
		level: "info" | "warn" | "error",
		message: string,
		fields?: Readonly<Record<string, unknown>>,
	) => void;
}

export type VelveAuthConfig<M extends IdentityMode> = BaseConfig<M> & RecoveryCodesRequirement<M>;
