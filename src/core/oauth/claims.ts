import { VelveError } from "../http/error-map.js";
import type { ResolvedProvider } from "./providers.js";

/**
 * What one provider says about one account. `emailVerified` is the provider's claim and nothing
 * more — it is the first of S-LINK-2's three conditions and never a link on its own.
 */
export interface ProviderAccount {
	readonly subject: string;
	readonly email: string | null;
	readonly emailVerified: boolean;
	readonly claims: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A dot walks into a nested claim, which is how a provider that answers `bot.owner.user.id` is read. */
function readClaimPath(claims: Record<string, unknown>, path: string): unknown {
	let current: unknown = claims;
	for (const segment of path.split(".")) {
		if (!isRecord(current)) {
			return undefined;
		}
		current = current[segment];
	}
	return current;
}

/** S-LINK-3: the subject is the provider's stable id, whatever its type on the wire — never the address. */
function subjectOf(claims: Record<string, unknown>, provider: ResolvedProvider): string {
	const value = readClaimPath(claims, provider.subjectClaim);
	if (typeof value === "string" && value !== "") {
		return value;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return String(value);
	}
	throw new VelveError("oauth_provider_error");
}

function emailOf(claims: Record<string, unknown>, provider: ResolvedProvider): string | null {
	if (provider.emailClaim === null) {
		return null;
	}
	const value = readClaimPath(claims, provider.emailClaim);
	return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The boolean and nothing else: `"true"` and `1` were accepted from memory of what providers send,
 * with no clause of the specification behind them, and this is the first of S-LINK-2's three
 * conditions — a claim shape read too widely is the condition read too widely (E-579).
 */
function emailVerifiedOf(claims: Record<string, unknown>, provider: ResolvedProvider): boolean {
	if (provider.emailVerifiedClaim === null) {
		return false;
	}
	return readClaimPath(claims, provider.emailVerifiedClaim) === true;
}

export function providerAccountOf(
	claims: Record<string, unknown>,
	provider: ResolvedProvider,
): ProviderAccount {
	const email = emailOf(claims, provider);
	return {
		subject: subjectOf(claims, provider),
		email,
		emailVerified: email !== null && emailVerifiedOf(claims, provider),
		claims,
	};
}
