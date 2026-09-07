import { VelveError } from "./error-map.js";
import { isRecord } from "./validators.js";

interface Redirect {
	readonly redirectToPath: string;
}

const PATH_CHARACTERS = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#]*$/;

/** S-REDIR-1 and S-REDIR-3: only a path reaches Location, never a value that could carry a scheme or a host. */
function isPathWithoutHost(path: string): boolean {
	return PATH_CHARACTERS.test(path) && !path.startsWith("//");
}

export function redirectTo(path: string): Redirect {
	if (!isPathWithoutHost(path)) {
		throw new VelveError("internal_error");
	}
	return { redirectToPath: path };
}

export function readRedirectPath(output: unknown): string | null {
	if (!isRecord(output) || typeof output.redirectToPath !== "string") {
		return null;
	}
	if (!isPathWithoutHost(output.redirectToPath)) {
		throw new VelveError("internal_error");
	}
	return output.redirectToPath;
}
