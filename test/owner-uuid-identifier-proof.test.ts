import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	dropSchema,
	type MigratedSchema,
	openMigratedSchema,
	readUserOwnedTables,
} from "./db-fixtures.js";

let migrated: MigratedSchema;

beforeAll(async () => {
	migrated = await openMigratedSchema("owneruuid");
});

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

interface IdColumn {
	readonly table_name: string;
	readonly data_type: string;
	readonly column_default: string | null;
	readonly is_primary_key: boolean;
}

async function idColumnsOf(tables: readonly string[]): Promise<IdColumn[]> {
	return migrated.connection.query<IdColumn>(
		`SELECT c.table_name, c.data_type, c.column_default,
		        EXISTS (
		          SELECT 1 FROM information_schema.table_constraints t
		          JOIN information_schema.key_column_usage k
		            ON k.constraint_name = t.constraint_name AND k.table_schema = t.table_schema
		          WHERE t.table_schema = c.table_schema AND t.table_name = c.table_name
		            AND t.constraint_type = 'PRIMARY KEY' AND k.column_name = 'id'
		        ) AS is_primary_key
		 FROM information_schema.columns c
		 WHERE c.table_schema = $1 AND c.column_name = 'id' AND c.table_name = ANY ($2::text[])
		 ORDER BY c.table_name`,
		[migrated.schema, `{${tables.join(",")}}`],
	);
}

//the user-bound tables are read from the catalogue and velve.user is held to the rule with them
describe("T-OWNER-9: every object identifier of a user-bound row is a random uuid (S-OWNER-9)", () => {
	it("reads the user-bound tables from the foreign keys, and finds the ones the schema names", async () => {
		const owned = (await readUserOwnedTables(migrated.connection, migrated.schema)).map(
			(each) => each.table,
		);

		expect(owned).toEqual(
			expect.arrayContaining([
				"session",
				"identity",
				"webauthn_credential",
				"one_time_token",
				"password_credential",
			]),
		);
	});

	it("types every id column uuid with gen_random_uuid() as its default and its primary key", async () => {
		const owned = (await readUserOwnedTables(migrated.connection, migrated.schema)).map(
			(each) => each.table,
		);
		const columns = await idColumnsOf(["user", ...owned]);

		expect(columns.map((column) => column.table_name)).toEqual(
			expect.arrayContaining(["identity", "session", "user", "webauthn_credential"]),
		);
		expect(
			columns.filter(
				(column) =>
					column.data_type !== "uuid" ||
					column.column_default !== "gen_random_uuid()" ||
					!column.is_primary_key,
			),
		).toStrictEqual([]);
	});

	//a table keyed by its owner or by a hash has no object identifier of its own to count up
	it("gives no user-bound table a single-column integer primary key", async () => {
		const owned = (await readUserOwnedTables(migrated.connection, migrated.schema)).map(
			(each) => each.table,
		);
		const keys = await migrated.connection.query<{ table_name: string; data_type: string }>(
			`SELECT k.table_name, c.data_type
			 FROM information_schema.table_constraints t
			 JOIN information_schema.key_column_usage k
			   ON k.constraint_name = t.constraint_name AND k.table_schema = t.table_schema
			 JOIN information_schema.columns c
			   ON c.table_schema = k.table_schema AND c.table_name = k.table_name
			  AND c.column_name = k.column_name
			 WHERE t.table_schema = $1 AND t.constraint_type = 'PRIMARY KEY'
			   AND k.table_name = ANY ($2::text[])
			   AND (SELECT count(*) FROM information_schema.key_column_usage other
			        WHERE other.constraint_name = t.constraint_name
			          AND other.table_schema = t.table_schema) = 1`,
			[migrated.schema, `{${["user", ...owned].join(",")}}`],
		);

		expect(keys.length).toBeGreaterThanOrEqual(owned.length / 2);
		expect(
			keys.filter((key) => ["smallint", "integer", "bigint"].includes(key.data_type)),
		).toStrictEqual([]);
	});

	it("would report a counted-up identifier, so a clean answer means something", async () => {
		await migrated.connection.query(
			`CREATE TABLE ${migrated.schema}.planted_owned (
			   id bigserial PRIMARY KEY,
			   user_id uuid NOT NULL REFERENCES ${migrated.schema}.user (id)
			 )`,
			[],
		);
		const columns = await idColumnsOf(["planted_owned"]);
		await migrated.connection.query(`DROP TABLE ${migrated.schema}.planted_owned`, []);

		expect(columns).toHaveLength(1);
		expect(columns[0]?.data_type).toBe("bigint");
		expect(columns[0]?.column_default).toMatch(/^nextval\(/);
	});
});
