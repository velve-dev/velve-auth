import type { Driver } from "../db/driver.js";
import { qualifiedTableName } from "../db/identifier.js";
import type { IdentityConfiguration, UsernameRules } from "./configuration.js";
import { normaliseEmail, normaliseUsername, type UsernameRejection } from "./normalise.js";

export interface ResolvedUserIdentity {
	readonly id: string;
	readonly email: string | null;
	readonly username: string | null;
	readonly emailVerified: boolean;
	readonly disabled: boolean;
}

export interface UserLookup {
	readonly driver: Driver;
	readonly schema: string;
	readonly configuration: IdentityConfiguration;
	readonly identifier: string;
}

export interface UsernameLookup {
	readonly driver: Driver;
	readonly schema: string;
	readonly rules: UsernameRules;
	readonly candidate: string;
}

export interface UsernameAvailability {
	readonly available: boolean;
	readonly reason?: UsernameRejection | "taken";
}

interface UserRow {
	readonly id: string;
	readonly email: string | null;
	readonly username: string | null;
	readonly email_verified: boolean;
	readonly disabled: boolean;
}

function emailPredicateValue(
	configuration: IdentityConfiguration,
	identifier: string,
): string | null {
	if (configuration.mode === "username") {
		return null;
	}
	const normalised = normaliseEmail(identifier);
	return normalised.accepted ? normalised.value : null;
}

function usernamePredicateValue(
	configuration: IdentityConfiguration,
	identifier: string,
): string | null {
	if (configuration.username === undefined) {
		return null;
	}
	const normalised = normaliseUsername(identifier, configuration.username);
	return normalised.accepted ? normalised.value.usernameKey : null;
}

/**
 * One statement, always executed, whatever the identifier turns out to be — an identifier
 * the allowlist rejects costs the same round trip as one that names an account (S-ENUM-1, E-46).
 * An allowlist wide enough to admit `@` can let one identifier match two accounts, so the
 * address wins over the username and the older row over the newer, rather than the planner.
 */
export async function findUserByIdentifier(
	lookup: UserLookup,
): Promise<ResolvedUserIdentity | null> {
	const table = qualifiedTableName(lookup.schema, "user");
	const [row] = await lookup.driver.query<UserRow>(
		`SELECT id,
		        email,
		        username,
		        (email_verified_at IS NOT NULL) AS email_verified,
		        (disabled_at IS NOT NULL) AS disabled
		 FROM ${table}
		 WHERE email = $1 OR username_key = $2
		 ORDER BY (email = $1) IS TRUE DESC, created_at, id
		 LIMIT 1`,
		[
			emailPredicateValue(lookup.configuration, lookup.identifier),
			usernamePredicateValue(lookup.configuration, lookup.identifier),
		],
	);
	if (row === undefined) {
		return null;
	}
	return {
		id: row.id,
		email: row.email,
		username: row.username,
		emailVerified: row.email_verified,
		disabled: row.disabled,
	};
}

/**
 * Usernames are enumerable by construction and this endpoint says so (S-ENUM-8); the rate
 * limit that keeps it usable rather than harmless belongs to the route, not to this function.
 */
export async function usernameAvailability(lookup: UsernameLookup): Promise<UsernameAvailability> {
	const normalised = normaliseUsername(lookup.candidate, lookup.rules);
	if (!normalised.accepted) {
		return { available: false, reason: normalised.rejection };
	}
	const table = qualifiedTableName(lookup.schema, "user");
	const rows = await lookup.driver.query<{ readonly taken: number }>(
		`SELECT 1 AS taken FROM ${table} WHERE username_key = $1 LIMIT 1`,
		[normalised.value.usernameKey],
	);
	return rows.length === 0 ? { available: true } : { available: false, reason: "taken" };
}
