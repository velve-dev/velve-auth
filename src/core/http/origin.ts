import { VelveError } from "./error-map.js";

function parseOrigin(value: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return null;
	}
	return parsed.origin === "null" ? null : parsed.origin;
}

export function isOriginAllowed(header: string | null, origins: readonly string[]): boolean {
	if (header === null) {
		return false;
	}
	const requestOrigin = parseOrigin(header);
	if (requestOrigin === null) {
		return false;
	}
	return origins.some((origin) => parseOrigin(origin) === requestOrigin);
}

export function assertOriginAllowed(header: string | null, origins: readonly string[]): void {
	if (!isOriginAllowed(header, origins)) {
		throw new VelveError("origin_not_allowed");
	}
}
