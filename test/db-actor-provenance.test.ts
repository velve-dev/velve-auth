import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, actorOfResolvedSession } from "../src/core/db/actor.js";
import { createOwnedRowRepository } from "../src/core/db/repositories/owned-row-repository.js";
import {
	actorOfTestUser,
	createUser,
	dropSchema,
	type MigratedSchema,
	openMigratedSchema,
} from "./db-fixtures.js";

let migrated: MigratedSchema;
let owner: Actor;
let stranger: Actor;
let credentials: ReturnType<typeof createOwnedRowRepository<{ id: string; user_id: string }>>;

async function createCredential(actor: Actor): Promise<string> {
	const [row] = await migrated.connection.query<{ id: string }>(
		`INSERT INTO ${migrated.schema}.webauthn_credential
		 (user_id, credential_id, public_key, backup_eligible, backup_state, user_verified_at_registration)
		 VALUES ($1, $2, $3, false, false, true) RETURNING id`,
		[actor, randomBytes(32), randomBytes(32)],
	);
	if (row === undefined) {
		throw new Error("the credential was not created");
	}
	return row.id;
}

beforeAll(async () => {
	migrated = await openMigratedSchema("velve_actor");
	owner = actorOfTestUser(await createUser(migrated.connection, migrated.schema));
	stranger = actorOfTestUser(await createUser(migrated.connection, migrated.schema));
	credentials = createOwnedRowRepository<{ id: string; user_id: string }>({
		driver: migrated.connection,
		schema: migrated.schema,
		table: "webauthn_credential",
		updatableColumns: ["label"],
	});
});

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

describe("every owner-scoped method demands an actor (S-OWNER-1, E-43)", () => {
	it("does not accept a plain string where an actor is required", () => {
		// @ts-expect-error S-OWNER-1: a bare string is not an actor, so the mistake cannot compile.
		const forged: Actor = "11111111-1111-4111-8111-111111111111";

		expect(typeof forged).toBe("string");
	});

	it("does not accept a call that leaves the actor out, and reaches nothing if one is forced through", async () => {
		const id = await createCredential(owner);

		// @ts-expect-error S-OWNER-1: there is no overload of this method without an actor.
		expect(await credentials.findOwnedRow({ id })).toBeNull();
		// @ts-expect-error S-OWNER-1: there is no overload of this method without an actor.
		expect(await credentials.listOwnedRows({})).toEqual([]);
		// @ts-expect-error S-OWNER-1: there is no overload of this method without an actor.
		expect(await credentials.deleteAllOwnedRows({})).toBe(0);

		expect(await credentials.findOwnedRow({ id, actor: owner })).not.toBeNull();
	});

	it("reaches no row of another user through any method", async () => {
		const id = await createCredential(owner);

		expect(await credentials.findOwnedRow({ id, actor: stranger })).toBeNull();
		expect(await credentials.listOwnedRows({ actor: stranger })).toEqual([]);
		expect(
			await credentials.updateOwnedRow({ id, actor: stranger, values: { label: "taken" } }),
		).toBeNull();
		expect(await credentials.deleteOwnedRow({ id, actor: stranger })).toBeNull();
		expect(await credentials.deleteAllOwnedRows({ actor: stranger })).toBe(0);

		expect(await credentials.findOwnedRow({ id, actor: owner })).not.toBeNull();
	});

	it("answers a foreign row and an invented one with the same value", async () => {
		const id = await createCredential(owner);

		expect(await credentials.findOwnedRow({ id, actor: stranger })).toEqual(
			await credentials.findOwnedRow({
				id: "00000000-0000-4000-8000-000000000000",
				actor: stranger,
			}),
		);
		expect(await credentials.deleteOwnedRow({ id, actor: stranger })).toEqual(
			await credentials.deleteOwnedRow({
				id: "00000000-0000-4000-8000-000000000000",
				actor: stranger,
			}),
		);
	});
});

describe("where an actor may come from (S-OWNER-7, E-93)", () => {
	it("mints none from an object session resolution did not produce", () => {
		const fromRequestBody = { userId: "00000000-0000-4000-8000-0000000000ff" };

		// @ts-expect-error S-OWNER-7: a hand-built object is not a resolved session.
		const minted: Actor = actorOfResolvedSession(fromRequestBody);

		expect(minted).toBe(fromRequestBody.userId);
	});
});
