import type { Session } from "../http/caller.js";
import { VelveError } from "../http/error-map.js";

export interface FreshnessWindow {
	readonly freshnessWindowMs: number;
	readonly now: Date;
}

/**
 * Architecture 3.5: freshness is the time since the sign-in, so it is measured against
 * `created_at` and never against `last_used_at`. Only a new session restores it.
 */
export function isSessionFresh(session: Session, window: FreshnessWindow): boolean {
	return window.now.getTime() - session.createdAt.getTime() < window.freshnessWindowMs;
}

export function assertSessionIsFresh(session: Session, window: FreshnessWindow): void {
	if (!isSessionFresh(session, window)) {
		throw new VelveError("freshness_required");
	}
}
