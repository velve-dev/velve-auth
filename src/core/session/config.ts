import type { CookieSameSite, HostPrefixedCookieName } from "../http/cookies.js";
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

function millisecondsOf(option: string, duration: Duration): number {
	const milliseconds = durationInMilliseconds(duration);
	if (milliseconds === null || milliseconds <= 0) {
		throw new InvalidSessionConfigError(
			`session.${option} must be a whole number of s, m, h or d above zero, not "${duration}"`,
		);
	}
	// Refused at startup rather than at the first insert, which is where the database would refuse it (E-1573).
	if (!Number.isSafeInteger(milliseconds)) {
		throw new InvalidSessionConfigError(
			`session.${option} is longer than a deadline this library can state exactly: "${duration}" is more than ${Number.MAX_SAFE_INTEGER} milliseconds`,
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
	return cookieName;
}

/** The startup reading of `session` (3.15 A.5); every deadline is decided here and nowhere else. */
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
		// The cookie cannot outlive the deadline that no use extends.
		cookieMaximumAgeInSeconds: Math.ceil(absoluteTimeoutMs / 1000),
		sameSite: complete.cookie.sameSite,
	};
}
