import type { User } from "../auth/user.js";
import type { IdentityMode } from "../db/migrations/identity-mode.js";
import type { AuthenticationFactor, Session } from "../http/caller.js";
import type { Clock } from "../http/environment.js";
import type { VelveErrorCode } from "../http/error-map.js";
import type { RateLimitRule } from "../http/rate-limit.js";
import type { RouteDeclaration } from "../http/route.js";
import type { SecurityStateFloor, SecurityStateSealedEvent } from "../security-state/anchor.js";

export type RevokeReason =
	| "sign_out"
	| "revoked_by_user"
	| "password_changed"
	| "password_reset"
	| "identity_linked"
	| "email_verified";

export interface SignInEvent {
	readonly method: "password" | "passkey" | "oauth" | "magic_link";
	readonly userId: string | null;
	readonly ipAddress: string | null;
	readonly userAgent: string | null;
}

export interface SignInCompletedEvent extends SignInEvent {
	readonly userId: string;
	readonly sessionId: string;
	readonly factors: readonly AuthenticationFactor[];
	readonly signCountRegressed?: boolean;
}

export interface SessionCreateEvent {
	readonly userId: string;
	readonly factors: readonly AuthenticationFactor[];
}

export interface SessionCreatedEvent extends SessionCreateEvent {
	readonly sessionId: string;
}

export interface UserCreateEvent {
	readonly email: string | null;
	readonly username: string | null;
}

export interface UserCreatedEvent extends UserCreateEvent {
	readonly userId: string;
}

export interface SessionRevokeEvent {
	readonly sessionId: string;
	readonly userId: string;
	readonly reason: RevokeReason;
}

export interface PluginActor {
	readonly pluginId: string;
	readonly reason: string;
}

/** no writing method on `user`, `password_credential`, `totp_credential` or `recovery_code` */
export interface FrozenRepositories {
	findUserById(input: { userId: string; actor: PluginActor }): Promise<User | null>;
	listSessionsForUser(input: { userId: string; actor: PluginActor }): Promise<Session[]>;
	revokeSession(input: {
		sessionId: string;
		reason: RevokeReason;
		actor: PluginActor;
	}): Promise<void>;
}

export interface FrozenContext {
	readonly clock: Clock;
	readonly identityMode: IdentityMode;
	readonly schema: string;
	readonly repositories: FrozenRepositories;
	readonly ownTables: {
		query<Row>(sql: string, params: readonly unknown[]): Promise<Row[]>;
	};
	log(
		level: "info" | "warn" | "error",
		message: string,
		fields?: Readonly<Record<string, unknown>>,
	): void;
}

/** the seven hook points, where a hook refuses by throwing and cannot replace the response */
export interface PluginHooks {
	beforeSignIn?: (event: SignInEvent, context: FrozenContext) => Promise<void>;
	afterSignIn?: (event: SignInCompletedEvent, context: FrozenContext) => Promise<void>;
	beforeSessionCreate?: (event: SessionCreateEvent, context: FrozenContext) => Promise<void>;
	afterSessionCreate?: (event: SessionCreatedEvent, context: FrozenContext) => Promise<void>;
	beforeUserCreate?: (event: UserCreateEvent, context: FrozenContext) => Promise<void>;
	afterUserCreate?: (event: UserCreatedEvent, context: FrozenContext) => Promise<void>;
	beforeSessionRevoke?: (event: SessionRevokeEvent, context: FrozenContext) => Promise<void>;
}

export interface PluginMigration<Id extends string> {
	readonly version: number;
	readonly name: string;
	readonly sql: string;
	readonly createsTables: readonly `${Id}_${string}`[];
}

/** who may call a plugin route, which never sees the pending or the OAuth state cookie */
export type PluginCallerRequirement = "anonymous" | "session" | "server_only";

/** a route a plugin declares, with its own error codes and no exemption from the origin check */
export type PluginRoute<Id extends string> = Omit<
	RouteDeclaration<
		`${Id}.${string}`,
		`/x/${Id}/${string}`,
		unknown,
		unknown,
		VelveErrorCode | `${Id}.${string}`
	>,
	"caller" | "originCheck" | "pendingCookie" | "oauthStateCookie" | "requestBody"
> & { readonly caller: PluginCallerRequirement; readonly originCheck: "checked" };

/** an anchor kept outside the reach of whoever can write the velve schema, which learns every new seal and sets a floor under its version */
export interface SecurityStateAnchor {
	recordSeal(event: SecurityStateSealedEvent, context: FrozenContext): Promise<void>;
	minimumVersion(
		input: { readonly userId: string },
		context: FrozenContext,
	): Promise<SecurityStateFloor | null>;
}

/** a plugin, whose declaration type cannot overwrite a core route */
export interface VelvePlugin<Id extends string = string> {
	readonly id: Id;
	readonly dependsOn?: readonly string[];
	readonly migrations?: readonly PluginMigration<Id>[];
	readonly routes?: readonly PluginRoute<Id>[];
	readonly hooks?: PluginHooks;
	readonly errorCodes?: readonly `${Id}.${string}`[];
	readonly rateLimitRules?: Readonly<Record<`${Id}.${string}`, RateLimitRule>>;
	readonly securityStateAnchor?: SecurityStateAnchor;
}
