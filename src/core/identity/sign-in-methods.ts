import type { Actor } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { qualifiedTableName } from "../db/identifier.js";
import { VelveError } from "../http/error-map.js";

export interface SignInMethodCount {
	readonly password: number;
	readonly webauthnCredentials: number;
	readonly linkedIdentities: number;
}

export type SignInMethodRemoval =
	| { readonly method: "password" }
	| { readonly method: "webauthn_credential"; readonly credentialId: string }
	| { readonly method: "linked_identity"; readonly identityId: string };

export interface SignInMethodQuery {
	readonly driver: Driver;
	readonly schema: string;
	readonly actor: Actor;
	readonly excluding?: SignInMethodRemoval;
}

export interface SignInMethodRemovalCheck {
	readonly transaction: Driver;
	readonly schema: string;
	readonly actor: Actor;
	readonly removing: SignInMethodRemoval;
}

interface CountRow {
	readonly password: number;
	readonly webauthn_credentials: number;
	readonly linked_identities: number;
}

export function totalSignInMethods(count: SignInMethodCount): number {
	return count.password + count.webauthnCredentials + count.linkedIdentities;
}

function excludedWebauthnCredentialId(removal: SignInMethodRemoval | undefined): string | null {
	return removal?.method === "webauthn_credential" ? removal.credentialId : null;
}

function excludedIdentityId(removal: SignInMethodRemoval | undefined): string | null {
	return removal?.method === "linked_identity" ? removal.identityId : null;
}

/**
 * Counts what {password, WebAuthn credential, linked identity} the account still holds (L-13).
 * A confirmed address and recovery codes are deliberately absent: neither is a sign-in name.
 */
export async function countSignInMethods(query: SignInMethodQuery): Promise<SignInMethodCount> {
	const password = qualifiedTableName(query.schema, "password_credential");
	const webauthn = qualifiedTableName(query.schema, "webauthn_credential");
	const identity = qualifiedTableName(query.schema, "identity");
	const [row] = await query.driver.query<CountRow>(
		`SELECT (SELECT count(*) FROM ${password}
		           WHERE user_id = $1 AND NOT $2::boolean)::int AS password,
		        (SELECT count(*) FROM ${webauthn}
		           WHERE user_id = $1 AND ($3::uuid IS NULL OR id <> $3::uuid))::int
		          AS webauthn_credentials,
		        (SELECT count(*) FROM ${identity}
		           WHERE user_id = $1 AND ($4::uuid IS NULL OR id <> $4::uuid))::int
		          AS linked_identities`,
		[
			query.actor,
			query.excluding?.method === "password",
			excludedWebauthnCredentialId(query.excluding),
			excludedIdentityId(query.excluding),
		],
	);
	if (row === undefined) {
		throw new VelveError("internal_error");
	}
	return {
		password: row.password,
		webauthnCredentials: row.webauthn_credentials,
		linkedIdentities: row.linked_identities,
	};
}

/**
 * Call this inside the transaction that performs the removal and before the DELETE. The row
 * lock serialises two concurrent removals that would each see the other's credential (L-13).
 */
export async function assertSignInMethodRemains(check: SignInMethodRemovalCheck): Promise<void> {
	const user = qualifiedTableName(check.schema, "user");
	await check.transaction.query(`SELECT id FROM ${user} WHERE id = $1 FOR UPDATE`, [check.actor]);
	const remaining = await countSignInMethods({
		driver: check.transaction,
		schema: check.schema,
		actor: check.actor,
		excluding: check.removing,
	});
	if (totalSignInMethods(remaining) === 0) {
		throw new VelveError("last_sign_in_method");
	}
}
