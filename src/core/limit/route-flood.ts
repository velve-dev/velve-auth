import type { BucketRule } from "../http/rate-limit.js";

export interface RouteFloodAlert {
	readonly routeName: string;
	readonly addressChecksObserved: number;
	readonly observedAt: Date;
}

export interface RouteFloodWatch {
	readonly rule: BucketRule;
	readonly onAlert: (alert: RouteFloodAlert) => void;
}

export interface RouteFloodCounter {
	observe(routeName: string, observedAt: Date): void;
}

interface RouteState {
	tokens: number;
	updatedAt: Date;
	addressChecksObserved: number;
	alerted: boolean;
}

function elapsedSeconds(from: Date, to: Date): number {
	return Math.max(0, (to.getTime() - from.getTime()) / 1000);
}

/** An alert sink that throws must not cost the caller its answer, as a logger that throws
 * does not (3.11). */
function alertQuietly(watch: RouteFloodWatch, alert: RouteFloodAlert): void {
	try {
		watch.onAlert(alert);
	} catch {
		return;
	}
}

/**
 * S-RATE-8: the per-route counter of one instance raises the alarm and refuses nothing. It is
 * refilled from the clock on each observation rather than reset by a timer, because a process
 * saturated by the very flood this exists to notice does not run its timers (E-186).
 */
export function createRouteFloodCounter(watch: RouteFloodWatch): RouteFloodCounter {
	const stateByRoute = new Map<string, RouteState>();

	return {
		observe(routeName, observedAt) {
			const state = stateByRoute.get(routeName) ?? {
				tokens: watch.rule.capacity,
				updatedAt: observedAt,
				addressChecksObserved: 0,
				alerted: false,
			};
			stateByRoute.set(routeName, state);

			const refilled =
				state.tokens + elapsedSeconds(state.updatedAt, observedAt) * watch.rule.refillPerSecond;
			state.tokens = Math.max(-1, Math.min(watch.rule.capacity, refilled) - 1);
			state.updatedAt = observedAt;
			state.addressChecksObserved += 1;

			if (state.tokens >= 0) {
				state.alerted = false;
				return;
			}
			if (!state.alerted) {
				state.alerted = true;
				alertQuietly(watch, {
					routeName,
					addressChecksObserved: state.addressChecksObserved,
					observedAt,
				});
			}
		},
	};
}
