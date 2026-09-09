import type { User } from "../auth/user.js";
import type { IdentityMode } from "../db/migrations/identity-mode.js";
import type { AuthenticationFactor, Session } from "../http/caller.js";
import type { Clock } from "../http/environment.js";
import type { VelveErrorCode } from "../http/error-map.js";
import type { RateLimitRule } from "../http/rate-limit.js";
import type { RouteDeclaration } from "../http/route.js";

export type RevokeReason =
	| "sign_out"
	| "revoked_by_user"
	| "password_changed"
	| "password_reset"
	| "identity_linked";

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

/** 3.11: no writing method on `velve.user`, `password_credential`, `totp_credential` or `recovery_code`. */
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

/**
 * Seven hook points, exactly those of 3.11. `Promise<void>` everywhere is what "a listener with a
 * veto" is written as: a hook refuses by throwing and observes by doing nothing, and it cannot
 * replace the response because it cannot return one.
 */
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

/**
 * 3.6 names the four routes that accept `__Host-velve_pending` and says every other route ignores
 * it completely; S-CSRF-5 says the same of the state pointer. A plugin route is one of the others,
 * so neither the caller requirement that resolves the pending state nor either cookie field is
 * reachable from a plugin's declaration (E-764).
 */
export type PluginCallerRequirement = "anonymous" | "session" | "server_only";

/**
 * 3.15 G writes the input and output as `any`; `AnyRoute` already sets `unknown` as the form. The
 * error type admits the plugin's own namespaced codes beside the core ones, which `error-map.ts`
 * resolves rather than the core union absorbing them (E-720).
 */
export type PluginRoute<Id extends string> = Omit<
	RouteDeclaration<
		`${Id}.${string}`,
		`/x/${Id}/${string}`,
		unknown,
		unknown,
		VelveErrorCode | `${Id}.${string}`
	>,
	"caller" | "pendingCookie" | "oauthStateCookie"
> & { readonly caller: PluginCallerRequirement };

/**
 * The namespace constraint is a type, not a runtime check: a plugin that wants to overwrite a core
 * route cannot satisfy the declaration type. The start error stays for plugins written in
 * JavaScript, where a name collision is a start error and not a warning (3.11).
 */
export interface VelvePlugin<Id extends string = string> {
	readonly id: Id;
	readonly dependsOn?: readonly string[];
	readonly migrations?: readonly PluginMigration<Id>[];
	readonly routes?: readonly PluginRoute<Id>[];
	readonly hooks?: PluginHooks;
	readonly errorCodes?: readonly `${Id}.${string}`[];
	readonly rateLimitRules?: Readonly<Record<`${Id}.${string}`, RateLimitRule>>;
}
