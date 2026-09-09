import type { User, UserRepository } from "../auth/user.js";
import type { IdentityMode } from "../db/migrations/identity-mode.js";
import type { SessionRepository } from "../db/repositories/session.js";
import type { Session } from "../http/caller.js";
import type { Clock, LogLevel } from "../http/environment.js";
import type { FrozenContext, FrozenRepositories, PluginActor, RevokeReason } from "./config.js";
import { createNoOwnTables, createOwnTables, type OwnTables } from "./own-tables.js";

class PluginActorError extends Error {
	readonly code = "plugin_actor_incomplete";

	constructor() {
		super("a repository call from a plugin names its pluginId and its reason, both non-empty");
		this.name = "PluginActorError";
	}
}

export type LogSink = (
	level: LogLevel,
	message: string,
	fields?: Readonly<Record<string, unknown>>,
) => void;

export interface FrozenContextServices {
	readonly clock: Clock;
	readonly identityMode: IdentityMode;
	readonly schema: string;
	readonly users: UserRepository;
	readonly sessions: SessionRepository;
	readonly driver: import("../db/driver.js").Driver;
	readonly log: LogSink;
}

function assertActorIsNamed(actor: PluginActor): PluginActor {
	if (
		typeof actor?.pluginId !== "string" ||
		typeof actor.reason !== "string" ||
		actor.pluginId === "" ||
		actor.reason === ""
	) {
		throw new PluginActorError();
	}
	return actor;
}

/** 3.15 G, E-737: both fields are mandatory and both are logged; neither authorises anything. */
function recorded(
	log: LogSink,
	method: string,
	actor: PluginActor,
	revokeReason?: RevokeReason,
): void {
	try {
		log("info", "a plugin reached a core repository", {
			method,
			pluginId: actor.pluginId,
			reason: actor.reason,
			...(revokeReason === undefined ? {} : { revokeReason }),
		});
	} catch {
		return;
	}
}

/**
 * 3.15 G: no writing method on `velve.user`, `password_credential`, `totp_credential` or
 * `recovery_code`, and the absence is the requirement — a plugin that could write a password or a
 * factor would be a co-owner of the core rather than a listener with a veto.
 */
function createFrozenRepositories(services: FrozenContextServices): FrozenRepositories {
	return Object.freeze({
		findUserById: (input: { userId: string; actor: PluginActor }): Promise<User | null> => {
			recorded(services.log, "findUserById", assertActorIsNamed(input.actor));
			return services.users.findUserById(input.userId);
		},

		listSessionsForUser: (input: { userId: string; actor: PluginActor }): Promise<Session[]> => {
			recorded(services.log, "listSessionsForUser", assertActorIsNamed(input.actor));
			return services.sessions.listSessionsOfUser({ userId: input.userId });
		},

		revokeSession: async (input: {
			sessionId: string;
			reason: RevokeReason;
			actor: PluginActor;
		}): Promise<void> => {
			// E-765: the `reason` is the only record this revocation leaves; no hook is dispatched for it.
			recorded(services.log, "revokeSession", assertActorIsNamed(input.actor), input.reason);
			await services.sessions.deleteSessionById({ sessionId: input.sessionId });
		},
	});
}

function freezeContext(
	services: FrozenContextServices,
	repositories: FrozenRepositories,
	ownTables: OwnTables,
): FrozenContext {
	return Object.freeze({
		clock: services.clock,
		identityMode: services.identityMode,
		schema: services.schema,
		repositories,
		ownTables,
		log: services.log,
	});
}

/**
 * `Object.freeze` refuses the change at run time and `readonly` refuses it at compile time; 3.15 G
 * asks for both because the first is what a JavaScript caller meets and the second is what a
 * TypeScript caller meets.
 */
export function createPluginContext(
	services: FrozenContextServices,
	pluginId: string,
): FrozenContext {
	return freezeContext(
		services,
		createFrozenRepositories(services),
		createOwnTables({ driver: services.driver, schema: services.schema, pluginId }),
	);
}

/** 3.15 D.1: every route carries a context, and a core route's has no tables of its own behind it. */
export function createCoreContext(services: FrozenContextServices): FrozenContext {
	return freezeContext(services, createFrozenRepositories(services), createNoOwnTables());
}
