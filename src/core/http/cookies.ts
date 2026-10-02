import { VelveError } from "./error-map.js";

export type HostPrefixedCookieName = `__Host-${string}`;

export type CookieSameSite = "lax" | "strict";

/**
 * The only attribute sets the library can express: no Domain, and no way to drop HttpOnly or
 * Secure, which is what S-COOKIE-2 asks of the session cookie. The third set is not S-COOKIE-2's
 * doing — section 1 H18 marks `SameSite=None` **Weglassen** — and it reaches exactly one cookie for
 * the reason set out below (E-582).
 */
export type CookieAttributes =
	| "HttpOnly; Secure; SameSite=Lax; Path=/"
	| "HttpOnly; Secure; SameSite=Strict; Path=/"
	| "HttpOnly; Secure; SameSite=None; Path=/";

export type OAuthResponseDelivery = "query" | "form_post";

export interface CookieNames {
	readonly session: HostPrefixedCookieName;
	readonly pending: HostPrefixedCookieName;
	readonly oauthState: HostPrefixedCookieName;
}

//this must stay the complete set of cookies the library ever sets (S-COOKIE-6)
export const DEFAULT_COOKIE_NAMES: CookieNames = {
	session: "__Host-velve_session",
	pending: "__Host-velve_pending",
	oauthState: "__Host-velve_oauth_state",
};

const PENDING_COOKIE_MAXIMUM_AGE_IN_SECONDS = 300;

//the state cookie must outlive the flow row it points at, never the other way round
const OAUTH_STATE_COOKIE_MAXIMUM_AGE_IN_SECONDS = 600;

export interface CookieInstruction {
	readonly name: HostPrefixedCookieName;
	readonly value: string;
	readonly maximumAgeInSeconds: number;
	readonly attributes: CookieAttributes;
}

export interface CookiePolicy {
	//only reading may use other names, the names written stay the defaults (S-COOKIE-6)
	readonly names: CookieNames;
	readonly sameSite: CookieSameSite;
	readonly sessionMaximumAgeInSeconds: number;
}

export interface CookieWriter {
	setSession(token: string): void;
	clearSession(): void;
	setPending(token: string): void;
	clearPending(): void;
	setOAuthState(pointer: string): void;
	/** The `form_post` flow of section 1 C50, whose callback the browser reaches by a cross-site POST. */
	setCrossSiteOAuthState(pointer: string): void;
	clearOAuthState(): void;
}

export interface CookieCollector extends CookieWriter {
	collect(): readonly CookieInstruction[];
}

const COOKIE_VALUE_CHARACTERS = /^[A-Za-z0-9._~-]*$/;
const COOKIE_NAME_CHARACTERS = /^__Host-[A-Za-z0-9_-]+$/;
const COOKIE_MAXIMUM_AGE_LIMIT_IN_SECONDS = 34_560_000;

const LAX_ATTRIBUTES = "HttpOnly; Secure; SameSite=Lax; Path=/";
const STRICT_ATTRIBUTES = "HttpOnly; Secure; SameSite=Strict; Path=/";
const CROSS_SITE_ATTRIBUTES = "HttpOnly; Secure; SameSite=None; Path=/";
const WRITABLE_ATTRIBUTES = new Set<string>([
	LAX_ATTRIBUTES,
	STRICT_ATTRIBUTES,
	CROSS_SITE_ATTRIBUTES,
]);

//a cross-site return carries no Strict cookie, and a form_post not even a Lax one (E-582)
const OAUTH_STATE_ATTRIBUTES: Readonly<Record<OAuthResponseDelivery, CookieAttributes>> = {
	query: LAX_ATTRIBUTES,
	form_post: CROSS_SITE_ATTRIBUTES,
};

export function oauthStateCookieFor(
	pointer: string,
	delivery: OAuthResponseDelivery,
): CookieInstruction {
	return {
		name: DEFAULT_COOKIE_NAMES.oauthState,
		value: pointer,
		maximumAgeInSeconds: OAUTH_STATE_COOKIE_MAXIMUM_AGE_IN_SECONDS,
		attributes: OAUTH_STATE_ATTRIBUTES[delivery],
	};
}

function cookieAttributesFor(sameSite: CookieSameSite): CookieAttributes {
	return sameSite === "lax" ? LAX_ATTRIBUTES : STRICT_ATTRIBUTES;
}

function isWritableAge(maximumAgeInSeconds: number): boolean {
	return (
		Number.isInteger(maximumAgeInSeconds) &&
		maximumAgeInSeconds >= 0 &&
		maximumAgeInSeconds <= COOKIE_MAXIMUM_AGE_LIMIT_IN_SECONDS
	);
}

//each part is read once, so a getter cannot answer differently after the check (S-COOKIE-2)
export function serializeCookie(instruction: CookieInstruction): string {
	const { name, value, maximumAgeInSeconds, attributes } = instruction;
	if (
		!COOKIE_NAME_CHARACTERS.test(name) ||
		!COOKIE_VALUE_CHARACTERS.test(value) ||
		!isWritableAge(maximumAgeInSeconds) ||
		!WRITABLE_ATTRIBUTES.has(attributes)
	) {
		throw new VelveError("internal_error");
	}
	return `${name}=${value}; Max-Age=${maximumAgeInSeconds}; ${attributes}`;
}

export function assertCookieNamesAreEnumerated(instructions: readonly CookieInstruction[]): void {
	const enumerated = new Set<string>(Object.values(DEFAULT_COOKIE_NAMES));
	for (const instruction of instructions) {
		if (!enumerated.has(instruction.name)) {
			throw new VelveError("internal_error");
		}
	}
}

export function createCookieCollector(policy: CookiePolicy): CookieCollector {
	const instructions = new Map<HostPrefixedCookieName, CookieInstruction>();
	const chosen = cookieAttributesFor(policy.sameSite);
	const written = DEFAULT_COOKIE_NAMES;

	function write(
		name: HostPrefixedCookieName,
		value: string,
		maximumAgeInSeconds: number,
		attributes: CookieAttributes,
	): void {
		instructions.set(name, { name, value, maximumAgeInSeconds, attributes });
	}

	function writeInstruction(instruction: CookieInstruction): void {
		instructions.set(instruction.name, instruction);
	}

	return {
		setSession: (token) => {
			write(written.session, token, policy.sessionMaximumAgeInSeconds, chosen);
		},
		clearSession: () => {
			write(written.session, "", 0, chosen);
		},
		setPending: (token) => {
			write(written.pending, token, PENDING_COOKIE_MAXIMUM_AGE_IN_SECONDS, chosen);
		},
		clearPending: () => {
			write(written.pending, "", 0, chosen);
		},
		setOAuthState: (pointer) => {
			writeInstruction(oauthStateCookieFor(pointer, "query"));
		},
		setCrossSiteOAuthState: (pointer) => {
			writeInstruction(oauthStateCookieFor(pointer, "form_post"));
		},
		clearOAuthState: () => {
			write(written.oauthState, "", 0, OAUTH_STATE_ATTRIBUTES.query);
		},
		collect: () => [...instructions.values()],
	};
}

interface CookieValues {
	readonly session: string | null;
	readonly pending: string | null;
	readonly oauthState: string | null;
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
		return { session: null, pending: null, oauthState: null };
	}
	const enumerated = new Set<string>(Object.values(names));
	const values = new Map<string, string>();
	for (const [name, value] of splitCookieHeader(header)) {
		if (!enumerated.has(name)) {
			continue;
		}
		//a second cookie of the same name must be rejected, never disambiguated (S-COOKIE-5)
		if (values.has(name)) {
			throw new VelveError("invalid_input");
		}
		values.set(name, value);
	}
	return {
		session: values.get(names.session) ?? null,
		pending: values.get(names.pending) ?? null,
		oauthState: values.get(names.oauthState) ?? null,
	};
}
