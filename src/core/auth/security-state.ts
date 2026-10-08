import { qualifiedTableName } from "../db/identifier.js";
import type { UnboundEnvelopeReading } from "../keys/envelope-binding.js";
import type { SecurityStateConfig } from "./config.js";

/** whether every account must carry a seal or the estate is still being sealed */
export type SealingMode = SecurityStateConfig["sealing"];

export const DEFAULT_SEALING: SealingMode = "required";

const SEALING_MODES: readonly SealingMode[] = ["required", "migrating"];

/** whether a configured securityState names one of the two sealing modes */
export function isStartableSecurityState(securityState: unknown): boolean {
	if (securityState === undefined) {
		return true;
	}
	if (typeof securityState !== "object" || securityState === null) {
		return false;
	}
	const { sealing } = securityState as { sealing?: unknown };
	return SEALING_MODES.includes(sealing as SealingMode);
}

export function sealingOf(securityState: SecurityStateConfig | undefined): SealingMode {
	return securityState?.sealing ?? DEFAULT_SEALING;
}

/** whether the account a stored envelope belongs to has a row in velve.security_state */
export type SealRowPresence = "present" | "absent";

/** the condition a statement selects beside an envelope, so the envelope and its account's seal row are one snapshot */
export function sealRowPresentFor(schema: string, ownerColumn: string): string {
	return `EXISTS (SELECT 1 FROM ${qualifiedTableName(schema, "security_state")} seal WHERE seal.user_id = ${ownerColumn})`;
}

export function sealRowPresenceOf(sealed: unknown): SealRowPresence {
	return sealed === true ? "present" : "absent";
}

//the unbound form is read only while migrating and only for an account without a seal row (S-INTEG-1)
export function unboundReadingOf(
	sealing: SealingMode,
	sealRow: SealRowPresence,
): UnboundEnvelopeReading {
	return sealing === "migrating" && sealRow === "absent" ? "readable" : "refused";
}
