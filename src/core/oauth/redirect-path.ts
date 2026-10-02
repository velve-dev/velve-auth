import { VelveError } from "../http/error-map.js";
import { type RedirectPath, toRedirectPath } from "../http/redirect.js";

export const DEFAULT_REDIRECT_PATH = "/";

//the check is applied again after the decoding, so it runs on three readings (E-581)
const DECODINGS_APPLIED = 2;

function decodedOnce(candidate: string): string | null {
	try {
		return decodeURIComponent(candidate);
	} catch {
		return null;
	}
}

//a redirect target must be a path and never a URL, in every reading a browser makes (S-REDIR-1)
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
