import {
	type CookieSameSite,
	DEFAULT_COOKIE_NAMES,
	type HostPrefixedCookieName,
} from "../http/cookies.js";
import { type Duration, durationInMilliseconds } from "./duration.js";

export interface SessionConfig {
	readonly idleTimeout: Duration;
	readonly absoluteTimeout: Duration;
	readonly idleWriteInterval: Duration;
	readonly freshnessWindow: Duration;
	readonly cookieName: HostPrefixedCookieName;
	readonly cookie: { readonly sameSite: CookieSameSite };
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
	idleTimeout: "7d",
	absoluteTimeout: "30d",
	idleWriteInterval: "1h",
	freshnessWindow: "15m",
	cookieName: "__Host-velve_session",
	cookie: { sameSite: "lax" },
};

export class InvalidSessionConfigError extends Error {
	readonly code = "invalid_session_config";

	constructor(message: string) {
		super(message);
		this.name = "InvalidSessionConfigError";
	}
}

export interface SessionSettings {
	readonly idleTimeoutMs: number;
	readonly absoluteTimeoutMs: number;
	readonly idleWriteIntervalMs: number;
	readonly freshnessWindowMs: number;
	readonly cookieName: HostPrefixedCookieName;
	readonly cookieMaximumAgeInSeconds: number;
	readonly sameSite: CookieSameSite;
}

const COOKIE_NAME = /^__Host-[A-Za-z0-9_-]+$/;

//a deadline is read back as a Date, whose range ends nearer than the largest safe integer (E-1584)
const LONGEST_DEADLINE_IN_MILLISECONDS = 8_640_000_000_000_000;

function millisecondsOf(option: string, duration: Duration): number {
	const milliseconds = durationInMilliseconds(duration);
	if (milliseconds === null || milliseconds <= 0) {
		throw new InvalidSessionConfigError(
			`session.${option} must be a whole number of s, m, h or d above zero, not "${duration}"`,
		);
	}
	//an unusable duration must fail at startup and not at the first insert (E-1573)
	if (!Number.isSafeInteger(milliseconds) || milliseconds > LONGEST_DEADLINE_IN_MILLISECONDS) {
		throw new InvalidSessionConfigError(
			`session.${option} must be at most ${LONGEST_DEADLINE_IN_MILLISECONDS} in milliseconds, where the Date this library hands back ends, not "${duration}"`,
		);
	}
	return milliseconds;
}

function assertBelow(shorter: [string, number], longer: [string, number]): void {
	if (shorter[1] > longer[1]) {
		throw new InvalidSessionConfigError(
			`session.${shorter[0]} must not exceed session.${longer[0]}`,
		);
	}
}

function assertCookieName(cookieName: HostPrefixedCookieName): HostPrefixedCookieName {
	if (!COOKIE_NAME.test(cookieName)) {
		throw new InvalidSessionConfigError(
			`session.cookieName must be __Host- followed by letters, digits, "-" or "_", not "${cookieName}"`,
		);
	}
	//a session cookie sharing a name with the pending or the state cookie would be read as either (S-COOKIE-6)
	if (
		cookieName === DEFAULT_COOKIE_NAMES.pending ||
		cookieName === DEFAULT_COOKIE_NAMES.oauthState
	) {
		throw new InvalidSessionConfigError(
			`session.cookieName must not be ${DEFAULT_COOKIE_NAMES.pending} or ${DEFAULT_COOKIE_NAMES.oauthState}, which the library sets itself`,
		);
	}
	return cookieName;
}

//every session deadline is decided here and nowhere else
export function sessionSettingsOf(config: Partial<SessionConfig> = {}): SessionSettings {
	const complete: SessionConfig = { ...DEFAULT_SESSION_CONFIG, ...config };
	const idleTimeoutMs = millisecondsOf("idleTimeout", complete.idleTimeout);
	const absoluteTimeoutMs = millisecondsOf("absoluteTimeout", complete.absoluteTimeout);
	const idleWriteIntervalMs = millisecondsOf("idleWriteInterval", complete.idleWriteInterval);
	const freshnessWindowMs = millisecondsOf("freshnessWindow", complete.freshnessWindow);

	assertBelow(["idleTimeout", idleTimeoutMs], ["absoluteTimeout", absoluteTimeoutMs]);
	assertBelow(["idleWriteInterval", idleWriteIntervalMs], ["idleTimeout", idleTimeoutMs]);
	assertBelow(["freshnessWindow", freshnessWindowMs], ["absoluteTimeout", absoluteTimeoutMs]);

	return {
		idleTimeoutMs,
		absoluteTimeoutMs,
		idleWriteIntervalMs,
		freshnessWindowMs,
		cookieName: assertCookieName(complete.cookieName),
		//the cookie must not outlive the deadline that no use extends
		cookieMaximumAgeInSeconds: Math.ceil(absoluteTimeoutMs / 1000),
		sameSite: complete.cookie.sameSite,
	};
}
