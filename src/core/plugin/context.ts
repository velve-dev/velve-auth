import type { User, UserRepository } from "../auth/user.js";
import type { IdentityMode } from "../db/migrations/identity-mode.js";
import type { SessionRepository } from "../db/repositories/session.js";
import type { Session } from "../http/caller.js";
import type { Clock, LogLevel } from "../http/environment.js";
import type {
	FrozenContext,
	FrozenRepositories,
	PluginActor,
	RevokeReason,
	SessionRevokeEvent,
} from "./config.js";
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
	readonly pluginDatabaseRole?: string;
	readonly insideATransaction?: boolean;
}

//a hook told about a revocation must not be told about its own (E-641)
export interface RevocationAnnouncement {
	announce(event: SessionRevokeEvent): Promise<void>;
	readonly listened: boolean;
}

export const SILENT_REVOCATION: RevocationAnnouncement = {
	announce: () => Promise.resolve(),
	listened: false,
};

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

//both actor fields are mandatory and logged and neither authorises anything (E-737)
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

//a plugin must not be able to write an account, a password or a factor
function createFrozenRepositories(
	services: FrozenContextServices,
	revocation: RevocationAnnouncement,
): FrozenRepositories {
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
			recorded(services.log, "revokeSession", assertActorIsNamed(input.actor), input.reason);
			//a revoke hook that throws must leave the session standing
			if (revocation.listened) {
				const userId = await services.sessions.findUserIdOfSession({
					sessionId: input.sessionId,
				});
				if (userId === null) {
					return;
				}
				await revocation.announce({
					sessionId: input.sessionId,
					userId,
					reason: input.reason,
				});
			}
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

//the context must refuse a change at run time and at compile time alike
export function createPluginContext(
	services: FrozenContextServices,
	pluginId: string,
	revocation: RevocationAnnouncement,
): FrozenContext {
	return freezeContext(
		services,
		createFrozenRepositories(services, revocation),
		createOwnTables({
			driver: services.driver,
			schema: services.schema,
			pluginId,
			...(services.pluginDatabaseRole === undefined
				? {}
				: { databaseRole: services.pluginDatabaseRole }),
			insideATransaction: services.insideATransaction === true,
		}),
	);
}

export function createCoreContext(
	services: FrozenContextServices,
	revocation: RevocationAnnouncement,
): FrozenContext {
	return freezeContext(
		services,
		createFrozenRepositories(services, revocation),
		createNoOwnTables(),
	);
}
