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

/** How a provider hands the authorization code back: in the query of a redirect, or in a posted form. */
export type OAuthResponseDelivery = "query" | "form_post";

export interface CookieNames {
	readonly session: HostPrefixedCookieName;
	readonly pending: HostPrefixedCookieName;
	readonly oauthState: HostPrefixedCookieName;
}

/** S-COOKIE-6: the complete set of cookies the library ever sets. */
export const DEFAULT_COOKIE_NAMES: CookieNames = {
	session: "__Host-velve_session",
	pending: "__Host-velve_pending",
	oauthState: "__Host-velve_oauth_state",
};

const PENDING_COOKIE_MAXIMUM_AGE_IN_SECONDS = 300;

/**
 * 3.10: the row in `velve.oauth_flow` is the authority and this cookie only points at it, so the
 * cookie must outlive the row rather than the other way round — a pointer that expires first turns
 * a working callback into `oauth_flow_invalid`.
 */
const OAUTH_STATE_COOKIE_MAXIMUM_AGE_IN_SECONDS = 600;

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

/**
 * 5.9 (a): the provider returns through a top-level cross-site GET, and a `SameSite=Strict` cookie
 * is not sent on one — the pointer would be missing exactly where the callback needs it. What
 * secures the callback is the server-side `state` and PKCE (3.10), not this attribute, so the
 * state cookie keeps `Lax` whatever the session cookie is configured to.
 *
 * A provider answering with `form_post` returns through a cross-site **POST**, which not even
 * `Lax` is sent on, so that flow's pointer is the one cookie of the library that carries
 * `SameSite=None`. Section 1 H18 rules that attribute out — *"mit `__Host-` und der Origin-Prüfung
 * nicht vorgesehen"* — and this is a deviation from it, argued and bounded in E-582: it reaches no
 * cookie that authenticates anything, and the route it reaches has no origin check to lose.
 */
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

// S-COOKIE-2: every part is read once and then checked, so a property that answers differently on the second read cannot pass.
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
		// S-COOKIE-5: a second cookie of the same name is rejected, never disambiguated.
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
