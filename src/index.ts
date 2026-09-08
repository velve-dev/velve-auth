export { type Actor, actorOfResolvedSession, type ResolvedSession } from "./core/db/actor.js";
export {
	createOwnedRowRepository,
	type OwnedRowRepository,
	type OwnedRowRepositoryOptions,
	UnknownColumnError,
} from "./core/db/repositories/owned-row-repository.js";

export const VELVE_AUTH_VERSION = "0.0.0";
