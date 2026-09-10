import { VelveError } from "../http/error-map.js";
import { type RedirectPath, toRedirectPath } from "../http/redirect.js";

/** Where the callback sends a browser that started a flow without naming a target. */
export const DEFAULT_REDIRECT_PATH = "/";

/**
 * S-REDIR-2 reads "the check happens after exactly one percent decoding **and is applied again
 * afterwards**", so the check runs three times over two decodings: on the candidate, on its one
 * decoding, and on the decoding of that. It is not a fixed point — a target that needs a fourth
 * reading is still accepted, and `test/oauth-redirect-corpus.test.ts` names the ones that are
 * (E-581).
 */
const DECODINGS_APPLIED = 2;

function decodedOnce(candidate: string): string | null {
	try {
		return decodeURIComponent(candidate);
	} catch {
		return null;
	}
}

/**
 * S-REDIR-1: a path, never a URL. `toRedirectPath` holds the single definition of what a path may
 * look like; this applies it to each reading a browser can produce and turns its refusal into the
 * caller's `invalid_input` (E-550).
 */
export function acceptedRedirectPath(candidate: string): RedirectPath {
	let reading = candidate;
	for (let decoding = 0; decoding <= DECODINGS_APPLIED; decoding += 1) {
		try {
			toRedirectPath(reading);
		} catch {
			throw new VelveError("invalid_input");
		}
		const next = decoding === DECODINGS_APPLIED ? reading : decodedOnce(reading);
		if (next === null) {
			throw new VelveError("invalid_input");
		}
		reading = next;
	}
	return toRedirectPath(candidate);
}
