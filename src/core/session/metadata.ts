import { canonicalIpAddress, truncatedIpAddress } from "./ip-address.js";
import { boundedUserAgent, truncatedUserAgent } from "./user-agent.js";

export type SessionMetadataMode = "truncated" | "full" | "none";

//data minimisation under the GDPR is the default and not a configuration task
export const DEFAULT_SESSION_METADATA_MODE: SessionMetadataMode = "truncated";

export interface SessionMetadata {
	readonly ipAddress: string | null;
	readonly userAgent: string | null;
}

const NOTHING: SessionMetadata = { ipAddress: null, userAgent: null };

function fullMetadata(observed: SessionMetadata): SessionMetadata {
	return {
		ipAddress: observed.ipAddress === null ? null : canonicalIpAddress(observed.ipAddress),
		userAgent: observed.userAgent === null ? null : boundedUserAgent(observed.userAgent),
	};
}

function truncatedMetadata(observed: SessionMetadata): SessionMetadata {
	return {
		ipAddress: observed.ipAddress === null ? null : truncatedIpAddress(observed.ipAddress),
		userAgent: observed.userAgent === null ? null : truncatedUserAgent(observed.userAgent),
	};
}

//the address is truncated before it leaves the process, never inside the statement (E-222)
export function sessionMetadataFor(
	mode: SessionMetadataMode,
	observed: SessionMetadata,
): SessionMetadata {
	switch (mode) {
		case "none":
			return NOTHING;
		case "full":
			return fullMetadata(observed);
		default:
			return truncatedMetadata(observed);
	}
}
