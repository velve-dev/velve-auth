import type { Clock } from "../http/environment.js";

/** the path that met a broken state */
export type SecurityStateAlarmOccasion =
	| "sign_in"
	| "factor_check"
	| "session_resolve"
	| "token_redemption"
	| "change"
	| "maintenance";

/** why a state was found broken */
export type SecurityStateAlarmReason =
	| "seal_missing"
	| "seal_mismatch"
	| "key_version_unknown"
	| "version_below_anchor"
	| "anchor_unavailable"
	| "anchor_mismatch"
	| "token_binding_mismatch"
	| "envelope_binding_mismatch"
	| "key_unusable";

/** what the application's alarm callback receives, never a secret, a token, a hash or a ciphertext */
export interface SecurityStateAlarm {
	readonly userId: string | null;
	readonly occasion: SecurityStateAlarmOccasion | "aggregate";
	readonly reason: SecurityStateAlarmReason | "suppressed";
	readonly suppressed: number;
}

/** the application's callback for a broken security state */
type SecurityStateAlarmCallback = (event: SecurityStateAlarm) => void;

/** a broken state a path reports, with no account for a row that has no owner */
export interface SecurityStateAlarmRaised {
	readonly userId: string | null;
	readonly occasion: SecurityStateAlarmOccasion;
	readonly reason: SecurityStateAlarmReason;
}

/** where every path reports a broken state, and which decides on its own what is delivered */
interface SecurityStateAlarms {
	raise(alarm: SecurityStateAlarmRaised): void;
}

/** the log the alarm writes its warn line and a failed delivery to */
type SecurityStateAlarmLog = (
	level: "warn" | "error",
	message: string,
	fields: Readonly<Record<string, unknown>>,
) => void;

const WINDOW_MILLISECONDS = 60_000;
const DELIVERIES_PER_WINDOW = 100;
const KEYS_HELD = 10_000;

function deduplicationKey(alarm: SecurityStateAlarmRaised): string {
	const account = alarm.userId === null ? "-" : `account:${alarm.userId}`;
	return `${account}|${alarm.occasion}|${alarm.reason}`;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { readonly then?: unknown }).then === "function"
	);
}

//a slow callback must not show in the time a refusal takes (S-INTEG-5)
function deliverOffTheResponsePath(
	event: SecurityStateAlarm,
	callback: SecurityStateAlarmCallback | undefined,
	log: SecurityStateAlarmLog,
): void {
	const fields = {
		userId: event.userId,
		occasion: event.occasion,
		reason: event.reason,
		suppressed: event.suppressed,
	};
	const reportFailure = () => {
		try {
			log("error", "security state alarm could not be delivered", {
				occasion: event.occasion,
				reason: event.reason,
			});
		} catch {
			return;
		}
	};
	setTimeout(() => {
		try {
			log("warn", "security state alarm", fields);
		} catch {
			reportFailure();
		}
		if (callback === undefined) {
			return;
		}
		try {
			const answer: unknown = callback(event);
			if (isThenable(answer)) {
				Promise.resolve(answer).catch(reportFailure);
			}
		} catch {
			reportFailure();
		}
	}, 0);
}

//no flood of broken accounts silences an alarm and none drops one without a count (E-3203)
export function createSecurityStateAlarms(options: {
	readonly callback: SecurityStateAlarmCallback | undefined;
	readonly log: SecurityStateAlarmLog;
	readonly clock: Clock;
}): SecurityStateAlarms {
	const deliveredAt = new Map<string, number>();
	let recentDeliveries: number[] = [];
	let suppressed = 0;
	let aggregateWindowStart = options.clock.now().getTime();

	function deliver(event: SecurityStateAlarm): void {
		suppressed = 0;
		deliverOffTheResponsePath(Object.freeze(event), options.callback, options.log);
	}

	return {
		raise(alarm) {
			const now = options.clock.now().getTime();
			const key = deduplicationKey(alarm);
			const lastDelivered = deliveredAt.get(key);
			if (lastDelivered !== undefined && now - lastDelivered < WINDOW_MILLISECONDS) {
				suppressed += 1;
				if (now - aggregateWindowStart >= WINDOW_MILLISECONDS) {
					aggregateWindowStart = now;
					deliver({ userId: null, occasion: "aggregate", reason: "suppressed", suppressed });
				}
				return;
			}
			recentDeliveries = recentDeliveries.filter(
				(deliveredTime) => now - deliveredTime < WINDOW_MILLISECONDS,
			);
			if (recentDeliveries.length >= DELIVERIES_PER_WINDOW) {
				suppressed += 1;
				return;
			}
			recentDeliveries.push(now);
			deliveredAt.delete(key);
			deliveredAt.set(key, now);
			const oldest = deliveredAt.keys().next();
			if (deliveredAt.size > KEYS_HELD && oldest.done !== true) {
				deliveredAt.delete(oldest.value);
			}
			deliver({ ...alarm, suppressed });
		},
	};
}
