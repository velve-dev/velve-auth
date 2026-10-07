import { UNBOUND_ENVELOPES_REFUSED, type UnboundEnvelopePolicy } from "../keys/envelope-binding.js";
import type { SecurityStateConfig } from "./config.js";

/** whether every account must carry a seal or the estate is still being sealed */
type SealingMode = SecurityStateConfig["sealing"];

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

/** whether an account has a row in velve.security_state */
export type SealRowPresence = "present" | "absent";

/** looks up whether an account has a seal row */
type SealRowLookup = (userId: string) => Promise<SealRowPresence>;

//nothing writes a seal row before the seal is built so every account reads as unsealed (E-3112)
export const NO_SEAL_ROW_IS_READ: SealRowLookup = () => Promise.resolve("absent");

//the unbound form is read only while migrating and only for an account without a seal row (S-INTEG-1)
export function unboundEnvelopePolicyOf(
	sealing: SealingMode,
	sealRowOf: SealRowLookup,
): UnboundEnvelopePolicy {
	if (sealing === "required") {
		return UNBOUND_ENVELOPES_REFUSED;
	}
	return {
		readingFor: async (owner) => ((await sealRowOf(owner)) === "absent" ? "readable" : "refused"),
	};
}
