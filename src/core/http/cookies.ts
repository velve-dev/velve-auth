import { VelveError } from "./error-map.js";

export type HostPrefixedCookieName = `__Host-${string}`;

export type CookieSameSite = "lax" | "strict";

/** S-COOKIE-2: the only two attribute sets the library can express — no Domain, no way to drop HttpOnly or Secure. */
export type CookieAttributes =
	| "HttpOnly; Secure; SameSite=Lax; Path=/"
	| "HttpOnly; Secure; SameSite=Strict; Path=/";

export interface CookieNames {
	readonly session: HostPrefixedCookieName;
	readonly pending: HostPrefixedCookieName;
}

/** S-COOKIE-6: the complete set of cookies the library ever sets. */
export const DEFAULT_COOKIE_NAMES: CookieNames = {
	session: "__Host-velve_session",
	pending: "__Host-velve_pending",
};

const PENDING_COOKIE_MAXIMUM_AGE_IN_SECONDS = 300;

export interface CookieInstruction {
	readonly name: HostPrefixedCookieName;
	readonly value: string;
	readonly maximumAgeInSeconds: number;
	readonly attributes: CookieAttributes;
}

export interface CookiePolicy {
	/** The names read from the request; the names written come from DEFAULT_COOKIE_NAMES (S-COOKIE-6). */
	readonly names: CookieNames;
	readonly sameSite: CookieSameSite;
	readonly sessionMaximumAgeInSeconds: number;
}

export interface CookieWriter {
	setSession(token: string): void;
	clearSession(): void;
	setPending(token: string): void;
	clearPending(): void;
}

export interface CookieCollector extends CookieWriter {
	collect(): readonly CookieInstruction[];
}

const COOKIE_VALUE_CHARACTERS = /^[A-Za-z0-9._~-]*$/;
const COOKIE_NAME_CHARACTERS = /^__Host-[A-Za-z0-9_-]+$/;

function cookieAttributesFor(sameSite: CookieSameSite): CookieAttributes {
	return sameSite === "lax"
		? "HttpOnly; Secure; SameSite=Lax; Path=/"
		: "HttpOnly; Secure; SameSite=Strict; Path=/";
}

export function serializeCookie(instruction: CookieInstruction): string {
	if (
		!COOKIE_NAME_CHARACTERS.test(instruction.name) ||
		!COOKIE_VALUE_CHARACTERS.test(instruction.value)
	) {
		throw new VelveError("internal_error");
	}
	return `${instruction.name}=${instruction.value}; Max-Age=${instruction.maximumAgeInSeconds}; ${instruction.attributes}`;
}

export function assertCookieNamesAreEnumerated(instructions: readonly CookieInstruction[]): void {
	const enumerated = new Set<string>([DEFAULT_COOKIE_NAMES.session, DEFAULT_COOKIE_NAMES.pending]);
	for (const instruction of instructions) {
		if (!enumerated.has(instruction.name)) {
			throw new VelveError("internal_error");
		}
	}
}

export function createCookieCollector(policy: CookiePolicy): CookieCollector {
	const instructions = new Map<HostPrefixedCookieName, CookieInstruction>();
	const attributes = cookieAttributesFor(policy.sameSite);
	const written = DEFAULT_COOKIE_NAMES;

	function write(name: HostPrefixedCookieName, value: string, maximumAgeInSeconds: number): void {
		instructions.set(name, { name, value, maximumAgeInSeconds, attributes });
	}

	return {
		setSession: (token) => {
			write(written.session, token, policy.sessionMaximumAgeInSeconds);
		},
		clearSession: () => {
			write(written.session, "", 0);
		},
		setPending: (token) => {
			write(written.pending, token, PENDING_COOKIE_MAXIMUM_AGE_IN_SECONDS);
		},
		clearPending: () => {
			write(written.pending, "", 0);
		},
		collect: () => [...instructions.values()],
	};
}

interface CookieValues {
	readonly session: string | null;
	readonly pending: string | null;
}

function splitCookieHeader(header: string): readonly (readonly [string, string])[] {
	const pairs: (readonly [string, string])[] = [];
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator > 0) {
			pairs.push([part.slice(0, separator).trim(), part.slice(separator + 1).trim()]);
		}
	}
	return pairs;
}

export function readCookies(header: string | null, names: CookieNames): CookieValues {
	if (header === null) {
		return { session: null, pending: null };
	}
	const enumerated = new Set<string>([names.session, names.pending]);
	const values = new Map<string, string>();
	for (const [name, value] of splitCookieHeader(header)) {
		if (!enumerated.has(name)) {
			continue;
		}
		// S-COOKIE-5: a second cookie of the same name is rejected, never disambiguated.
		if (values.has(name)) {
			throw new VelveError("invalid_input");
		}
		values.set(name, value);
	}
	return {
		session: values.get(names.session) ?? null,
		pending: values.get(names.pending) ?? null,
	};
}
