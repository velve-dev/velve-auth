import { decodeBase64Url } from "../keys/base64url.js";
import { equalsInConstantTime } from "../keys/constant-time.js";

/** a new seal as the anchor learns it after commit, with the digest in base64url */
export interface SecurityStateSealedEvent {
	readonly userId: string;
	readonly version: number;
	readonly digest: string;
}

/** the highest version an anchor recorded for an account, with that version's digest in base64url */
export interface SecurityStateFloor {
	readonly version: number;
	readonly digest: string;
}

/** one anchor as the request path calls it, already bound to the context of the plugin that contributed it */
export interface SecurityStateAnchorPort {
	minimumVersion(input: { readonly userId: string }): Promise<SecurityStateFloor | null>;
	recordSeal(event: SecurityStateSealedEvent): Promise<void>;
}

/** a floor the library could read, with its digest decoded */
interface DecodedFloor {
	readonly version: number;
	readonly digest: Uint8Array<ArrayBuffer>;
}

/** what asking every anchor about one account found, one floor or null per anchor */
export type AnchorReading =
	| { readonly kind: "answered"; readonly floors: readonly (DecodedFloor | null)[] }
	| { readonly kind: "unavailable" };

/** what comparing a stored seal with the anchors' floors found */
export type AnchorVerdict =
	| "within_floor"
	| "ahead_of_anchor"
	| "version_below_anchor"
	| "anchor_mismatch"
	| "anchor_unavailable";

const DIGEST_BYTES = 32;

//a nan or a fraction compares false against every version and would let any seal through (E-3286)
export function decodeAnchorFloor(answer: unknown): DecodedFloor | null | "malformed" {
	if (answer === null) {
		return null;
	}
	if (typeof answer !== "object") {
		return "malformed";
	}
	const { version, digest } = answer as { readonly version?: unknown; readonly digest?: unknown };
	if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
		return "malformed";
	}
	const decoded = typeof digest === "string" ? decodeBase64Url(digest) : null;
	if (decoded === null || decoded.length !== DIGEST_BYTES) {
		return "malformed";
	}
	return { version, digest: decoded };
}

//an anchor that throws is answered like one whose answer cannot be read (E-3286)
export async function consultAnchors(
	anchors: readonly SecurityStateAnchorPort[],
	userId: string,
): Promise<AnchorReading> {
	const answers = await Promise.all(
		anchors.map((anchor) =>
			Promise.resolve()
				.then(() => anchor.minimumVersion({ userId }))
				.then(
					(answer: unknown) => decodeAnchorFloor(answer),
					() => "malformed" as const,
				),
		),
	);
	const floors: (DecodedFloor | null)[] = [];
	for (const answer of answers) {
		if (answer === "malformed") {
			return { kind: "unavailable" };
		}
		floors.push(answer);
	}
	return { kind: "answered", floors };
}

/** compares the version and digest a check read with every floor, the stored seal being null for an account without one */
export function compareWithAnchors(
	stored: { readonly version: number; readonly digest: Uint8Array<ArrayBuffer> } | null,
	reading: AnchorReading,
): AnchorVerdict {
	if (reading.kind === "unavailable") {
		return "anchor_unavailable";
	}
	let ahead = false;
	for (const floor of reading.floors) {
		if (floor === null) {
			ahead ||= stored !== null;
			continue;
		}
		if (stored === null || stored.version < floor.version) {
			return "version_below_anchor";
		}
		if (stored.version === floor.version && !equalsInConstantTime(stored.digest, floor.digest)) {
			return "anchor_mismatch";
		}
		ahead ||= stored.version > floor.version;
	}
	return ahead ? "ahead_of_anchor" : "within_floor";
}

//a failed record is reported and never undoes the committed change (E-3084)
export async function recordSealWithAnchors(
	anchors: readonly SecurityStateAnchorPort[],
	event: SecurityStateSealedEvent,
	reportFailure: () => void,
): Promise<void> {
	const outcomes = await Promise.allSettled(
		anchors.map((anchor) => Promise.resolve().then(() => anchor.recordSeal(event))),
	);
	if (outcomes.some((outcome) => outcome.status === "rejected")) {
		reportFailure();
	}
}
