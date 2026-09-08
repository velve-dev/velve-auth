const MAXIMUM_STORED_LENGTH = 512;

/** Ordered: a marker that appears inside another product's string comes first. */
const BROWSER_FAMILIES: readonly (readonly [string, string])[] = [
	["Edge", "Edg/"],
	["Edge", "EdgA/"],
	["Edge", "EdgiOS/"],
	["Opera", "OPR/"],
	["Opera", "OPiOS/"],
	["Samsung Internet", "SamsungBrowser/"],
	["Firefox", "FxiOS/"],
	["Firefox", "Firefox/"],
	["Chromium", "Chromium/"],
	["Chrome", "CriOS/"],
	["Chrome", "Chrome/"],
	["Safari", "Safari/"],
];

const SYSTEM_FAMILIES: readonly (readonly [string, string])[] = [
	["Android", "Android"],
	["iOS", "iPhone"],
	["iOS", "iPad"],
	["iOS", "iPod"],
	["macOS", "Macintosh"],
	["macOS", "Mac OS X"],
	["Windows", "Windows"],
	["Chrome OS", "CrOS"],
	["Linux", "Linux"],
];

function familyOf(
	userAgent: string,
	families: readonly (readonly [string, string])[],
): string | null {
	for (const [family, marker] of families) {
		if (userAgent.includes(marker)) {
			return family;
		}
	}
	return null;
}

/** L-10: browser and system family only — everything that identifies the single device is dropped. */
export function truncatedUserAgent(userAgent: string): string | null {
	const browser = familyOf(userAgent, BROWSER_FAMILIES);
	const system = familyOf(userAgent, SYSTEM_FAMILIES);
	if (browser !== null && system !== null) {
		return `${browser} on ${system}`;
	}
	return browser ?? system;
}

/** A client chooses this header's length, and `text` has no limit of its own. */
export function boundedUserAgent(userAgent: string): string | null {
	const trimmed = userAgent.trim();
	return trimmed === "" ? null : trimmed.slice(0, MAXIMUM_STORED_LENGTH);
}
