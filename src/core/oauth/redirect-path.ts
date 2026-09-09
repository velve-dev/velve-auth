import { VelveError } from "../http/error-map.js";
import { type RedirectPath, toRedirectPath } from "../http/redirect.js";

/** Where the callback sends a browser that started a flow without naming a target. */
export const DEFAULT_REDIRECT_PATH = "/";

function decodedOnce(candidate: string): string | null {
	try {
		return decodeURIComponent(candidate);
	} catch {
		return null;
	}
}

/**
 * S-REDIR-1 and S-REDIR-2: a path, never a URL, judged before and after exactly one percent
 * decoding — `/%2F%2Fevil.example` is protocol-relative once the browser has read it.
 * `toRedirectPath` holds the single definition of what a path may look like; this adds the second
 * reading and turns its refusal into the caller's `invalid_input` (E-550).
 */
export function acceptedRedirectPath(candidate: string): RedirectPath {
	const once = decodedOnce(candidate);
	if (once === null) {
		throw new VelveError("invalid_input");
	}
	try {
		toRedirectPath(once);
		return toRedirectPath(candidate);
	} catch {
		throw new VelveError("invalid_input");
	}
}
