import type { Session } from "../http/caller.js";
import { VelveError } from "../http/error-map.js";

export interface FreshnessWindow {
	readonly freshnessWindowMs: number;
	readonly now: Date;
}

//freshness is measured from the sign-in and never from the last use
export function isSessionFresh(session: Session, window: FreshnessWindow): boolean {
	return window.now.getTime() - session.createdAt.getTime() < window.freshnessWindowMs;
}

export function assertSessionIsFresh(session: Session, window: FreshnessWindow): void {
	if (!isSessionFresh(session, window)) {
		throw new VelveError("freshness_required");
	}
}
