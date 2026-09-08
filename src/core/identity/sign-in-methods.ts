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

export interface SignInMethodRemovalRequest {
	readonly driver: Driver;
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

/** A confirmed address and recovery codes are absent by decision: neither is a sign-in name (L-13). */
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

const REMOVAL_TABLE: Readonly<Record<SignInMethodRemoval["method"], string>> = {
	password: "password_credential",
	webauthn_credential: "webauthn_credential",
	linked_identity: "identity",
};

function removalStatement(
	schema: string,
	removal: SignInMethodRemoval,
): { readonly sql: string; readonly params: readonly unknown[] } {
	const table = qualifiedTableName(schema, REMOVAL_TABLE[removal.method]);
	switch (removal.method) {
		case "password":
			return { sql: `DELETE FROM ${table} WHERE user_id = $1`, params: [] };
		case "webauthn_credential":
			return {
				sql: `DELETE FROM ${table} WHERE user_id = $1 AND id = $2`,
				params: [removal.credentialId],
			};
		case "linked_identity":
			return {
				sql: `DELETE FROM ${table} WHERE user_id = $1 AND id = $2`,
				params: [removal.identityId],
			};
	}
}

async function removeUnderALockThatHolds(
	driver: Driver,
	request: SignInMethodRemovalRequest,
): Promise<boolean> {
	// velve.user is locked before any other table this call reads or writes.
	const user = qualifiedTableName(request.schema, "user");
	await driver.query(`SELECT id FROM ${user} WHERE id = $1 FOR UPDATE`, [request.actor]);
	const remaining = await countSignInMethods({
		driver,
		schema: request.schema,
		actor: request.actor,
		excluding: request.removing,
	});
	if (totalSignInMethods(remaining) === 0) {
		throw new VelveError("last_sign_in_method");
	}
	// A row lock assigns a transaction id, and outside a transaction block it is gone by the
	// next statement — which is how this asks whether the lock it just took still holds.
	const [held] = await driver.query<{ readonly lock_outlives_its_statement: boolean }>(
		`SELECT pg_current_xact_id_if_assigned() IS NOT NULL AS lock_outlives_its_statement`,
		[],
	);
	if (held?.lock_outlives_its_statement !== true) {
		return false;
	}
	const removal = removalStatement(request.schema, request.removing);
	await driver.query(removal.sql, [request.actor, ...removal.params]);
	return true;
}

/** Throws `last_sign_in_method` and removes nothing when this is the account's last way in (L-13). */
export async function removeSignInMethod(request: SignInMethodRemovalRequest): Promise<void> {
	if (await removeUnderALockThatHolds(request.driver, request)) {
		return;
	}
	await request.driver.transaction(async (transaction) => {
		if (!(await removeUnderALockThatHolds(transaction, request))) {
			throw new VelveError("internal_error");
		}
	});
}
