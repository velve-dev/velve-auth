import { afterEach, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import type { VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth, type VelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { asJavaScriptPlugin } from "./plugin-fixtures.js";

interface Migrated {
	readonly connection: TestConnection;
	readonly schema: string;
	readonly start: (plugins: readonly VelvePlugin[]) => VelveAuth<"email">;
}

const opened: Migrated[] = [];

async function migratedSchema(): Promise<Migrated> {
	const { connection, schema } = await openMigratedSchema("pluginmigration");
	const migrated: Migrated = {
		connection,
		schema,
		start: (plugins) =>
			createVelveAuth(configFor({ database: connection as Driver, schema, plugins })),
	};
	opened.push(migrated);
	return migrated;
}

afterEach(async () => {
	for (const migrated of opened.splice(0)) {
		await migrated.connection.query("DROP TABLE IF EXISTS public.audit_stray", []);
		await dropSchema(migrated.connection, migrated.schema);
		await migrated.connection.close();
	}
});

/** 3.15 G.1 numbers a plugin's first migration `1`, which is the number the core's first carries. */
function auditPlugin(): VelvePlugin<"audit"> {
	return {
		id: "audit",
		migrations: [
			{
				version: 1,
				name: "create_audit_entry",
				createsTables: ["audit_entry"],
				sql: `CREATE TABLE velve.audit_entry (
					id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
					user_id uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
					note text NOT NULL
				);`,
			},
		],
	};
}

async function tablesIn(migrated: Migrated): Promise<string[]> {
	const rows = await migrated.connection.query<{ table_name: string }>(
		"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
		[migrated.schema],
	);
	return rows.map((row) => row.table_name);
}

async function pluginLedgerOf(migrated: Migrated): Promise<string[]> {
	const rows = await migrated.connection.query<{ plugin_id: string; version: number }>(
		`SELECT plugin_id, version FROM ${migrated.schema}.plugin_schema_migration
		 ORDER BY plugin_id, version`,
		[],
	);
	return rows.map((row) => `${row.plugin_id}@${row.version}`);
}

async function refusalOf(
	migrated: Migrated,
	plugin: VelvePlugin,
): Promise<{ readonly code?: string }> {
	return migrated
		.start([plugin])
		.migrate()
		.then(() => ({}))
		.catch((error: { code?: string }) => error);
}

describe("a plugin's migrations run in the same runner (3.11)", () => {
	it("applies a plugin migration numbered 1 beside the core's own migration 1", async () => {
		const migrated = await migratedSchema();

		const report = await migrated.start([auditPlugin()]).migrate();

		expect(report.currentVersion).toBe(2);
		expect(await tablesIn(migrated)).toContain("audit_entry");
		expect(await pluginLedgerOf(migrated)).toStrictEqual(["audit@1"]);
	});

	it("keys the ledger on the plugin, so two plugins both number their first migration 1", async () => {
		const badge: VelvePlugin<"badge"> = {
			id: "badge",
			migrations: [
				{
					version: 1,
					name: "create_badge_entry",
					createsTables: ["badge_entry"],
					sql: "CREATE TABLE velve.badge_entry (id uuid PRIMARY KEY DEFAULT gen_random_uuid());",
				},
			],
		};
		const migrated = await migratedSchema();

		await migrated.start([auditPlugin(), badge]).migrate();

		expect(await pluginLedgerOf(migrated)).toStrictEqual(["audit@1", "badge@1"]);
	});

	it("applies nothing a second time", async () => {
		const migrated = await migratedSchema();
		await migrated.start([auditPlugin()]).migrate();

		const again = await migrated.start([auditPlugin()]).migrate();

		expect(again.appliedVersions).toStrictEqual([]);
		expect(await pluginLedgerOf(migrated)).toStrictEqual(["audit@1"]);
	});

	it("refuses a migration whose text changed after it was applied", async () => {
		const migrated = await migratedSchema();
		await migrated.start([auditPlugin()]).migrate();
		const edited: VelvePlugin<"audit"> = {
			id: "audit",
			migrations: [
				{
					version: 1,
					name: "create_audit_entry",
					createsTables: ["audit_entry"],
					sql: "CREATE TABLE velve.audit_entry (id uuid PRIMARY KEY);",
				},
			],
		};

		await expect(migrated.start([edited]).migrate()).rejects.toMatchObject({
			code: "migration_checksum_changed",
		});
	});

	it("creates no ledger of its own where no plugin brings a migration", async () => {
		const migrated = await migratedSchema();

		await migrated.start([]).migrate();

		expect(await tablesIn(migrated)).not.toContain("plugin_schema_migration");
	});
});

describe("what a plugin migration is refused for", () => {
	it("refuses a table it created and did not declare", async () => {
		const migrated = await migratedSchema();

		const refusal = await refusalOf(migrated, {
			id: "audit",
			migrations: [
				{
					version: 1,
					name: "two_tables",
					createsTables: ["audit_entry"],
					sql: `CREATE TABLE velve.audit_entry (id uuid PRIMARY KEY);
						CREATE TABLE velve.audit_shadow (id uuid PRIMARY KEY);`,
				},
			],
		} satisfies VelvePlugin<"audit">);

		expect(refusal.code).toBe("migration_table_undeclared");
		expect(await tablesIn(migrated)).not.toContain("audit_entry");
		expect(await pluginLedgerOf(migrated)).toStrictEqual([]);
	});

	/**
	 * 3.15 G.1's own example writes `CREATE TABLE sign_in_log_entry`, which lands wherever the
	 * connection's search_path points and not in the schema. The refusal rolls the statement back;
	 * the cleanup below is for the case where somebody has removed the refusal to see it fail.
	 */
	it("refuses a declared table the statement created somewhere else", async () => {
		const migrated = await migratedSchema();

		const refusal = await refusalOf(migrated, {
			id: "audit",
			migrations: [
				{
					version: 1,
					name: "unqualified",
					createsTables: ["audit_stray"],
					sql: "CREATE TABLE audit_stray (id uuid PRIMARY KEY);",
				},
			],
		} satisfies VelvePlugin<"audit">);

		expect(refusal.code).toBe("migration_table_undeclared");
	});

	it("refuses a table that does not carry the plugin's prefix", async () => {
		const migrated = await migratedSchema();

		const refusal = await refusalOf(
			migrated,
			asJavaScriptPlugin({
				id: "audit",
				migrations: [
					{
						version: 1,
						name: "foreign_name",
						createsTables: [],
						sql: "CREATE TABLE velve.something_else (id uuid PRIMARY KEY);",
					},
				],
			}),
		);

		expect(refusal.code).toBe("migration_table_unprefixed");
	});

	it("refuses a migration that adds a column to a core table", async () => {
		const migrated = await migratedSchema();

		const refusal = await refusalOf(migrated, {
			id: "audit",
			migrations: [
				{
					version: 1,
					name: "widen_the_user",
					createsTables: [],
					sql: "ALTER TABLE velve.user ADD COLUMN audit_note text;",
				},
			],
		} satisfies VelvePlugin<"audit">);

		expect(refusal.code).toBe("migration_foreign_table_changed");
	});

	it("refuses a migration that drops a core table", async () => {
		const migrated = await migratedSchema();

		const refusal = await refusalOf(migrated, {
			id: "audit",
			migrations: [
				{
					version: 1,
					name: "drop_the_buckets",
					createsTables: [],
					sql: "DROP TABLE velve.rate_bucket;",
				},
			],
		} satisfies VelvePlugin<"audit">);

		expect(refusal.code).toBe("migration_foreign_table_changed");
	});

	/** S-TOKEN-6, along the path a plugin actually takes. */
	it("refuses a plugin table that references the user without ON DELETE CASCADE", async () => {
		const migrated = await migratedSchema();

		const refusal = await refusalOf(migrated, {
			id: "audit",
			migrations: [
				{
					version: 1,
					name: "no_cascade",
					createsTables: ["audit_entry"],
					sql: `CREATE TABLE velve.audit_entry (
						id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
						user_id uuid NOT NULL REFERENCES velve.user(id)
					);`,
				},
			],
		} satisfies VelvePlugin<"audit">);

		expect(refusal.code).toBe("migration_missing_cascade");
	});
});

describe("the start refuses what no migration should reach the database with (S-DEFAULT-5)", () => {
	it("refuses a declared table outside the plugin's own prefix", async () => {
		const migrated = await migratedSchema();

		expect(() =>
			migrated.start([
				asJavaScriptPlugin({
					id: "audit",
					migrations: [{ version: 1, name: "x", createsTables: ["session"], sql: "SELECT 1;" }],
				}),
			]),
		).toThrowError(/outside its own prefix/);
	});

	it("refuses two plugins where one id is the table prefix of the other", async () => {
		const migrated = await migratedSchema();

		expect(() => migrated.start([{ id: "audit" }, { id: "audit_trail" }])).toThrowError(
			/table prefix of another/,
		);
	});
});
