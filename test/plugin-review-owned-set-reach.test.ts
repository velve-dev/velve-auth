import { afterEach, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import type { VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import {
	asJavaScriptPlugin,
	asTheMigrationRole,
	createTheMigrationRole,
	dropTheMigrationRole,
	type MigrationRole,
} from "./plugin-fixtures.js";

interface Opened {
	readonly connection: TestConnection;
	readonly schema: string;
	readonly role: MigrationRole;
}

const opened: Opened[] = [];

async function openSchema(): Promise<Opened> {
	const { connection, schema } = await openMigratedSchema("ownedreach");
	const role = await createTheMigrationRole(connection, schema);
	const instance = { connection, schema, role };
	opened.push(instance);
	return instance;
}

afterEach(async () => {
	for (const instance of opened.splice(0)) {
		await dropSchema(instance.connection, instance.schema);
		await dropTheMigrationRole(instance.connection, instance.role);
		await instance.connection.close();
	}
});

/** A start error and a refused migration both count as a refusal; only a migration that ran does not. */
async function migrateWith(instance: Opened, plugin: VelvePlugin): Promise<string> {
	return asTheMigrationRole(instance.role, async (roleDriver) => {
		try {
			await createVelveAuth(
				configFor({ database: roleDriver as Driver, schema: instance.schema, plugins: [plugin] }),
			).migrate();
			return "migrated";
		} catch (cause) {
			return (cause as { code?: string }).code ?? `refused without a code: ${String(cause)}`;
		}
	});
}

async function relationsOfTheSessionTable(instance: Opened): Promise<readonly string[]> {
	const rows = await instance.connection.query<{ name: string }>(
		`SELECT relation.relname AS name FROM pg_class relation
		 JOIN pg_namespace namespace_ ON namespace_.oid = relation.relnamespace
		 WHERE namespace_.nspname = $1
		   AND (relation.relname = 'session' OR relation.oid IN (
		     SELECT entry.indexrelid FROM pg_index entry
		     WHERE entry.indrelid = to_regclass($1 || '.session')))
		 ORDER BY relation.relname`,
		[instance.schema],
	);
	return rows.map((row) => row.name);
}

async function parentsOfTheSessionTable(instance: Opened): Promise<number> {
	const rows = await instance.connection.query<{ parents: number }>(
		`SELECT count(*)::integer AS parents FROM pg_inherits
		 WHERE inhrelid = to_regclass($1 || '.session')`,
		[instance.schema],
	);
	return rows[0]?.parents ?? -1;
}

function pluginInheritingTheSessionTable(secondSql?: string): VelvePlugin {
	const migrations = [
		{
			version: 1,
			name: "adopt_the_session_table",
			createsTables: ["demo_entry"],
			sql: "CREATE TABLE velve.demo_entry (); ALTER TABLE velve.session INHERIT velve.demo_entry;",
		},
	];
	if (secondSql !== undefined) {
		migrations.push({
			version: 2,
			name: "act_on_the_adopted_table",
			createsTables: [],
			sql: secondSql,
		} as unknown as (typeof migrations)[number]);
	}
	return asJavaScriptPlugin({ id: "demo", migrations });
}

/**
 * The runner's owned set walks `pg_depend` outward from the declared tables (E-918). `ALTER TABLE
 * <core> INHERIT <own>` records the core table as a dependent of the plugin's table, and with an
 * empty parent it changes no catalogue row of the core table that the touched-relation read sees,
 * so the core table, its indexes and the constraints referencing it join the plugin's own set.
 */
describe("a plugin table cannot adopt a core table as its child (3.11, S-DEFAULT-5)", () => {
	it("refuses a migration that makes the session table inherit from a plugin table", async () => {
		const instance = await openSchema();

		const outcome = await migrateWith(instance, pluginInheritingTheSessionTable());

		expect(outcome).not.toBe("migrated");
		expect(await parentsOfTheSessionTable(instance)).toBe(0);
	});

	it("refuses a later migration that drops a core index of the adopted session table", async () => {
		const instance = await openSchema();
		const before = await relationsOfTheSessionTable(instance);

		const outcome = await migrateWith(
			instance,
			pluginInheritingTheSessionTable("DROP INDEX velve.session_sweep_idx;"),
		);

		expect(outcome).not.toBe("migrated");
		expect(await relationsOfTheSessionTable(instance)).toEqual(before);
	});

	it("refuses a later migration that drops the adopted session table itself", async () => {
		const instance = await openSchema();
		const before = await relationsOfTheSessionTable(instance);

		const outcome = await migrateWith(
			instance,
			pluginInheritingTheSessionTable("DROP TABLE velve.session CASCADE;"),
		);

		expect(outcome).not.toBe("migrated");
		expect(await relationsOfTheSessionTable(instance)).toEqual(before);
	});
});

/**
 * `createsTables` is copied element by element, so an element that is a `String` object reaches the
 * runner as that object. It reads as `demo_entry` to every check that converts it to a string, and
 * the runner's array literal calls the element's own `replace` (E-2480, E-900).
 */
function nameThatSpellsTwoNamesInTheArrayLiteral(): string {
	const name = new String("demo_entry");
	Object.defineProperty(name, "replace", { value: () => 'demo_entry","session' });
	return name as unknown as string;
}

describe("a declared table name is read once, as a string (3.11, E-900)", () => {
	it("refuses a declared name that is not a string primitive", async () => {
		const instance = await openSchema();
		const before = await relationsOfTheSessionTable(instance);

		const outcome = await migrateWith(
			instance,
			asJavaScriptPlugin({
				id: "demo",
				migrations: [
					{
						version: 1,
						name: "declare_an_object",
						createsTables: [nameThatSpellsTwoNamesInTheArrayLiteral()],
						sql: "CREATE TABLE velve.demo_entry (id integer PRIMARY KEY);",
					},
					{
						version: 2,
						name: "reach_the_session_table",
						createsTables: [],
						sql: "DROP INDEX velve.session_sweep_idx;",
					},
				],
			}),
		);

		expect(outcome).not.toBe("migrated");
		expect(await relationsOfTheSessionTable(instance)).toEqual(before);
	});
});
