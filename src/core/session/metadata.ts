import { canonicalIpAddress, truncatedIpAddress } from "./ip-address.js";
import { boundedUserAgent, truncatedUserAgent } from "./user-agent.js";

export type SessionMetadataMode = "truncated" | "full" | "none";

/** L-10: data minimisation under Art. 5 (1) (c) GDPR is the default, not a configuration task. */
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

/** L-10: the truncation runs before the value leaves the process, so the full address is not in the statement either. */
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
