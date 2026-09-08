import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/core/db/actor.js";
import { createOwnedRowRepository } from "../src/core/db/repositories/owned-row-repository.js";
import {
	actorOfTestUser,
	type ColumnFact,
	countRowsOwnedBy,
	createUser,
	dropSchema,
	insertRowOwnedBy,
	type MigratedSchema,
	openMigratedSchema,
	readColumns,
	readUserOwnedTables,
	type UserOwnedTable,
} from "./db-fixtures.js";

const SPECIFIED_USER_OWNED_TABLES = 13;

let migrated: MigratedSchema;
let columns: readonly ColumnFact[];
let owned: readonly UserOwnedTable[];

beforeAll(async () => {
	migrated = await openMigratedSchema("velve_cascade");
	columns = await readColumns(migrated.connection, migrated.schema);
	owned = await readUserOwnedTables(migrated.connection, migrated.schema);
});

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

describe("deleting a user (S-TOKEN-5)", () => {
	it("finds the thirteen user-owned tables in the catalogue, not in a written list", () => {
		expect(owned).toHaveLength(SPECIFIED_USER_OWNED_TABLES);
	});

	it("gives every one of them a foreign key that cascades", async () => {
		const rows = await migrated.connection.query<{ table_name: string }>(
			`SELECT child.relname AS table_name
			 FROM pg_constraint constraint_
			 JOIN pg_class child ON child.oid = constraint_.conrelid
			 JOIN pg_namespace namespace_ ON namespace_.oid = child.relnamespace
			 WHERE namespace_.nspname = $1 AND constraint_.contype = 'f'
			   AND constraint_.confrelid = to_regclass($2)::oid
			   AND constraint_.confdeltype <> 'c'`,
			[migrated.schema, `${migrated.schema}.user`],
		);

		expect(rows).toEqual([]);
	});

	it("empties every one of them when the user goes", async () => {
		const userId = await createUser(migrated.connection, migrated.schema);
		for (const table of owned) {
			await insertRowOwnedBy(migrated.connection, migrated.schema, table, userId, columns);
		}

		const before = await Promise.all(
			owned.map((table) => countRowsOwnedBy(migrated.connection, migrated.schema, table, userId)),
		);
		expect(before).toEqual(owned.map(() => 1));

		await migrated.connection.query(`DELETE FROM ${migrated.schema}.user WHERE id = $1`, [userId]);

		const after = await Promise.all(
			owned.map(async (table) => ({
				table: table.table,
				remaining: await countRowsOwnedBy(migrated.connection, migrated.schema, table, userId),
			})),
		);
		expect(after).toEqual(owned.map((table) => ({ table: table.table, remaining: 0 })));
	});

	it("leaves another user's rows alone", async () => {
		const kept = await createUser(migrated.connection, migrated.schema);
		const removed = await createUser(migrated.connection, migrated.schema);
		for (const table of owned) {
			await insertRowOwnedBy(migrated.connection, migrated.schema, table, kept, columns);
			await insertRowOwnedBy(migrated.connection, migrated.schema, table, removed, columns);
		}

		await migrated.connection.query(`DELETE FROM ${migrated.schema}.user WHERE id = $1`, [removed]);

		const after = await Promise.all(
			owned.map((table) => countRowsOwnedBy(migrated.connection, migrated.schema, table, kept)),
		);
		expect(after).toEqual(owned.map(() => 1));
	});
});

describe("the owner predicate on every user-owned table (S-OWNER-2)", () => {
	it("keeps a stranger away from each of the thirteen tables", async () => {
		const ownerId = await createUser(migrated.connection, migrated.schema);
		const strangerId = await createUser(migrated.connection, migrated.schema);
		const ownerActor: Actor = actorOfTestUser(ownerId);
		const strangerActor: Actor = actorOfTestUser(strangerId);

		for (const table of owned) {
			await insertRowOwnedBy(migrated.connection, migrated.schema, table, ownerId, columns);
		}

		for (const table of owned) {
			const repository = createOwnedRowRepository({
				driver: migrated.connection,
				schema: migrated.schema,
				table: table.table,
				idColumn: table.ownerColumn,
				ownerColumn: table.ownerColumn,
			});

			expect(await repository.listOwnedRows({ actor: strangerActor })).toEqual([]);
			expect(await repository.deleteAllOwnedRows({ actor: strangerActor })).toBe(0);
			expect(await repository.listOwnedRows({ actor: ownerActor })).toHaveLength(1);
		}
	});
});
