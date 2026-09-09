/**
 * What `@velve/auth` exports on behalf of the plugin interface. `src/index.ts` re-exports this
 * module whole, so the feature that owns plugins adds a name here and never in the shared barrel.
 */
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
} from "./config.js";
