import type { UsernameRules } from "./configuration.js";
import { caseFolded, codePointCount } from "./fold.js";

export type Normalisation<Value, Rejection> =
	| { readonly accepted: true; readonly value: Value }
	| { readonly accepted: false; readonly rejection: Rejection };

export type EmailRejection = "malformed" | "too_long";

export type UsernameRejection = "invalid_characters" | "too_short" | "too_long" | "reserved";

export interface NormalisedUsername {
	readonly username: string;
	readonly usernameKey: string;
}

/** RFC 5321 section 4.5.3.1.3 caps a reverse-path at 256 octets including the angle brackets. */
const MAXIMUM_EMAIL_BYTES = 254;

const INVISIBLE_OR_SEPARATING = /[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}]/u;

function accept<Value>(value: Value): Normalisation<Value, never> {
	return { accepted: true, value };
}

function reject<Rejection>(rejection: Rejection): Normalisation<never, Rejection> {
	return { accepted: false, rejection };
}

function isStructurallyAnAddress(candidate: string): boolean {
	const separator = candidate.indexOf("@");
	return (
		separator > 0 &&
		separator === candidate.lastIndexOf("@") &&
		separator < candidate.length - 1 &&
		!INVISIBLE_OR_SEPARATING.test(candidate)
	);
}

export function normaliseEmail(candidate: string): Normalisation<string, EmailRejection> {
	const normalised = caseFolded(candidate.trim().normalize("NFKC"));
	if (!isStructurallyAnAddress(normalised)) {
		return reject("malformed");
	}
	if (new TextEncoder().encode(normalised).length > MAXIMUM_EMAIL_BYTES) {
		return reject("too_long");
	}
	return accept(normalised);
}

export function normaliseUsername(
	candidate: string,
	rules: UsernameRules,
): Normalisation<NormalisedUsername, UsernameRejection> {
	const username = candidate.trim().normalize("NFKC");
	// The caller's own pattern runs on this input, so its length is settled before it does.
	if (codePointCount(username) > rules.maximumLength) {
		return reject("too_long");
	}
	const usernameKey = caseFolded(username);
	// Judged on the comparison form so that case alone never decides acceptance; whether a
	// homoglyph gets through is the caller's pattern to answer, not this line's (E-17).
	if (!rules.allowedCharacters.test(usernameKey)) {
		return reject("invalid_characters");
	}
	const length = codePointCount(usernameKey);
	if (length > rules.maximumLength) {
		return reject("too_long");
	}
	if (length < rules.minimumLength) {
		return reject("too_short");
	}
	if (rules.reservedNames.includes(usernameKey)) {
		return reject("reserved");
	}
	return accept({ username, usernameKey });
}
