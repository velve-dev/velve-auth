import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/core/db/actor.js";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import {
	createOwnedRowRepository,
	UnknownColumnError,
} from "../src/core/db/repositories/owned-row-repository.js";
import { actorOfTestUser } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

interface WebAuthnCredentialRow {
	id: string;
	user_id: string;
	label: string | null;
	sign_count: string;
}

const schema = `velve_repo_${randomBytes(6).toString("hex")}`;
let connection: TestConnection;
let owner: Actor;
let stranger: Actor;
let credentials: ReturnType<typeof createOwnedRowRepository<WebAuthnCredentialRow>>;

async function createUser(email: string): Promise<Actor> {
	const [row] = await connection.query<{ id: string }>(
		`INSERT INTO ${schema}.user (email) VALUES ($1) RETURNING id`,
		[email],
	);
	if (row === undefined) {
		throw new Error("the user was not created");
	}
	return actorOfTestUser(row.id);
}

async function createCredential(actor: Actor, label: string): Promise<string> {
	const [row] = await connection.query<{ id: string }>(
		`INSERT INTO ${schema}.webauthn_credential
		 (user_id, credential_id, public_key, backup_eligible, backup_state, user_verified_at_registration, label)
		 VALUES ($1, $2, $3, false, false, true, $4) RETURNING id`,
		[actor, randomBytes(32), randomBytes(32), label],
	);
	if (row === undefined) {
		throw new Error("the credential was not created");
	}
	return row.id;
}

async function countCredentials(actor: Actor): Promise<number> {
	const rows = await connection.query(
		`SELECT id FROM ${schema}.webauthn_credential WHERE user_id = $1`,
		[actor],
	);
	return rows.length;
}

beforeAll(async () => {
	connection = await openTestConnection();
	await runMigrations({ driver: connection, schema, migrations: coreMigrations("email") });
	owner = await createUser("owner@example.com");
	stranger = await createUser("stranger@example.com");
	credentials = createOwnedRowRepository<WebAuthnCredentialRow>({
		driver: connection,
		schema,
		table: "webauthn_credential",
		updatableColumns: ["label", "sign_count"],
	});
});

afterAll(async () => {
	await connection.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, []);
	await connection.close();
});

describe("owner-scoped repository (S-OWNER-1, S-OWNER-2)", () => {
	it("finds a row for its owner", async () => {
		const id = await createCredential(owner, "laptop");

		const row = await credentials.findOwnedRow({ id, actor: owner });

		expect(row?.label).toBe("laptop");
	});

	it("answers a stranger the same way it answers an invented id", async () => {
		const id = await createCredential(owner, "phone");

		const foreign = await credentials.findOwnedRow({ id, actor: stranger });
		const invented = await credentials.findOwnedRow({
			id: "00000000-0000-4000-8000-000000000000",
			actor: stranger,
		});

		expect(foreign).toBeNull();
		expect(invented).toBeNull();
	});

	it("lists only the rows of the acting user", async () => {
		const strangerCredential = await createCredential(stranger, "stranger key");

		const rows = await credentials.listOwnedRows({ actor: owner });

		expect(rows.map((row) => row.id)).not.toContain(strangerCredential);
		expect(rows.every((row) => row.user_id === owner)).toBe(true);
	});

	it("does not update a row belonging to someone else", async () => {
		const id = await createCredential(owner, "before");

		const updated = await credentials.updateOwnedRow({
			id,
			actor: stranger,
			values: { label: "after" },
		});

		expect(updated).toBeNull();
		expect((await credentials.findOwnedRow({ id, actor: owner }))?.label).toBe("before");
	});

	it("updates a row for its owner", async () => {
		const id = await createCredential(owner, "before");

		const updated = await credentials.updateOwnedRow({
			id,
			actor: owner,
			values: { label: "after", sign_count: 7 },
		});

		expect(updated?.label).toBe("after");
		expect(updated?.sign_count).toBe("7");
	});

	it("refuses to write a column that was not declared updatable", async () => {
		const id = await createCredential(owner, "locked");

		await expect(
			credentials.updateOwnedRow({ id, actor: owner, values: { user_id: stranger } }),
		).rejects.toBeInstanceOf(UnknownColumnError);
	});

	it("does not delete a row belonging to someone else", async () => {
		const id = await createCredential(owner, "target");
		const before = await countCredentials(owner);

		const deleted = await credentials.deleteOwnedRow({ id, actor: stranger });

		expect(deleted).toBeNull();
		expect(await countCredentials(owner)).toBe(before);
	});

	it("deletes a row for its owner and returns it", async () => {
		const id = await createCredential(owner, "retired");

		const deleted = await credentials.deleteOwnedRow({ id, actor: owner });

		expect(deleted?.id).toBe(id);
		expect(await credentials.findOwnedRow({ id, actor: owner })).toBeNull();
	});

	it("deletes every row of the acting user and no other", async () => {
		const strangerCount = await countCredentials(stranger);

		const deleted = await credentials.deleteAllOwnedRows({ actor: owner });

		expect(deleted).toBeGreaterThan(0);
		expect(await countCredentials(owner)).toBe(0);
		expect(await countCredentials(stranger)).toBe(strangerCount);
	});
});
