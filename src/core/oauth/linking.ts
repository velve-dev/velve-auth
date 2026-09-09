import type { User, UserRepository } from "../auth/user.js";
import { normaliseEmail } from "../identity/normalise.js";
import type { ProviderAccount } from "./claims.js";
import type { ResolvedProvider } from "./providers.js";

/**
 * The three conditions of S-LINK-2, each named and each required. Better Auth read the second one
 * never (CVE-2026-53516, CVSS 8.3) and, after the fix, made it switchable; here there is no
 * parameter that removes one of the three and no order in which two of them suffice.
 */
interface AutomaticLinkConditions {
	readonly providerReportsTheAddressVerified: boolean;
	readonly localAccountHasEmailVerifiedAt: boolean;
	readonly providerIsTrusted: boolean;
}

export function automaticLinkIsAllowed(conditions: AutomaticLinkConditions): boolean {
	return (
		conditions.providerReportsTheAddressVerified &&
		conditions.localAccountHasEmailVerifiedAt &&
		conditions.providerIsTrusted
	);
}

/**
 * S-LINK-1: the address is an attribute, so the lookup by address happens only after the two
 * conditions that do not need it already hold, and its result is accepted only if the third does.
 * A caller that reaches this function with an unverified address or an untrusted provider gets
 * `null` before any query runs.
 */
export async function accountAnAutomaticLinkMayJoin(input: {
	readonly users: UserRepository;
	readonly account: ProviderAccount;
	readonly provider: ResolvedProvider;
}): Promise<User | null> {
	const address = input.account.email;
	if (
		address === null ||
		!input.account.emailVerified ||
		!input.provider.trustedForAutomaticLinking
	) {
		return null;
	}

	const normalised = normaliseEmail(address);
	if (!normalised.accepted) {
		return null;
	}

	const candidate = await input.users.findUserByEmail(normalised.value);
	if (candidate === null) {
		return null;
	}

	return automaticLinkIsAllowed({
		providerReportsTheAddressVerified: input.account.emailVerified,
		localAccountHasEmailVerifiedAt: candidate.emailVerifiedAt !== null,
		providerIsTrusted: input.provider.trustedForAutomaticLinking,
	})
		? candidate
		: null;
}
