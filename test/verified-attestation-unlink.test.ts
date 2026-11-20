import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/core/db/actor.js";
import { countSignInMethods, removeSignInMethod } from "../src/core/identity/sign-in-methods.js";
import { actorOfTestUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";

/**
 * L-13 under an authenticator allowlist (S-INTEG-13, E-3853): the count every removal of a
 * sign-in method asks — unlinking an identity, removing a passkey, removing a password — counts a
 * passkey only where the account's list lets it sign in, so unlinking the last identity of an
 * account whose passkeys all lie outside its list is refused as removing its last way in.
 */

const ALLOWED = "2fc0579f-8113-47ea-b116-bb5a8db9202a";
const OTHER = "cb69481e-8ff7-4039-93ec-0a2729a154a8";

let connection: TestConnection;
let schema: string;

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("attest_unlink"));
}, 60_000);

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

async function accountWith(allowlist: readonly string[] | null): Promise<Actor> {
	const [row] = await connection.query<{ id: string }>(
		`INSERT INTO ${schema}.user (email, allowed_aaguids) VALUES ($1, CASE WHEN $2::jsonb IS NULL THEN NULL
		   ELSE ARRAY(SELECT jsonb_array_elements_text($2::jsonb))::uuid[] END) RETURNING id`,
		[
			`${randomBytes(8).toString("hex")}@example.test`,
			allowlist === null ? null : JSON.stringify(allowlist),
		],
	);
	if (row === undefined) {
		throw new Error("the account was not created");
	}
	return actorOfTestUser(row.id);
}

async function addPasskey(actor: Actor, aaguid: string, verified: boolean): Promise<void> {
	await connection.query(
		`INSERT INTO ${schema}.webauthn_credential
		   (user_id, credential_id, public_key, aaguid, attestation_verified, backup_eligible,
		    backup_state, user_verified_at_registration)
		 VALUES ($1, $2, $3, $4, $5, false, false, true)`,
		[actor, randomBytes(16), randomBytes(64), aaguid, verified],
	);
}

async function addIdentity(actor: Actor): Promise<string> {
	const [row] = await connection.query<{ id: string }>(
		`INSERT INTO ${schema}.identity (user_id, provider, subject) VALUES ($1, $2, $3) RETURNING id`,
		[actor, "github", randomBytes(8).toString("hex")],
	);
	if (row === undefined) {
		throw new Error("the identity was not created");
	}
	return row.id;
}

function unlink(actor: Actor, identityId: string) {
	return removeSignInMethod({
		driver: connection,
		schema,
		actor,
		removing: { method: "linked_identity", identityId },
	});
}

async function identitiesOf(actor: Actor): Promise<number> {
	const [row] = await connection.query<{ total: number }>(
		`SELECT count(*)::integer AS total FROM ${schema}.identity WHERE user_id = $1`,
		[actor],
	);
	return row?.total ?? -1;
}

describe("unlinking the last identity under a list (L-13, S-INTEG-13)", () => {
	it("refuses where every passkey lies outside the list, unverified or of another model", async () => {
		const actor = await accountWith([ALLOWED]);
		await addPasskey(actor, ALLOWED, false);
		await addPasskey(actor, OTHER, true);
		const identityId = await addIdentity(actor);
		expect(
			(await countSignInMethods({ driver: connection, schema, actor })).webauthnCredentials,
		).toBe(0);
		await expect(unlink(actor, identityId)).rejects.toMatchObject({ code: "last_sign_in_method" });
		expect(await identitiesOf(actor)).toBe(1);
	});

	it("unlinks where a passkey satisfies the list, and counts every passkey without a list", async () => {
		const listed = await accountWith([ALLOWED]);
		await addPasskey(listed, ALLOWED, true);
		await unlink(listed, await addIdentity(listed));
		expect(await identitiesOf(listed)).toBe(0);

		const unlisted = await accountWith(null);
		await addPasskey(unlisted, OTHER, false);
		expect(
			(await countSignInMethods({ driver: connection, schema, actor: unlisted }))
				.webauthnCredentials,
		).toBe(1);
		await unlink(unlisted, await addIdentity(unlisted));
		expect(await identitiesOf(unlisted)).toBe(0);
	});
});
