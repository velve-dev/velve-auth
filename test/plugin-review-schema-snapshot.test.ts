import { afterAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import type { VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { createUser, dropSchema, uniqueSchemaName } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { asMigrationRole, grantTheMigrationRole } from "./plugin-fixtures.js";

let shared: TestConnection | undefined;
const schemas: string[] = [];

async function connection(): Promise<TestConnection> {
	shared ??= await openTestConnection();
	return shared;
}

async function freshSchema(): Promise<string> {
	const driver = await connection();
	const schema = uniqueSchemaName("pluginsnapshot");
	await runMigrations({ driver, schema, migrations: coreMigrations("email") });
	await grantTheMigrationRole(driver, schema);
	schemas.push(schema);
	return schema;
}

afterAll(async () => {
	const driver = shared;
	if (driver === undefined) {
		return;
	}
	for (const schema of schemas.splice(0)) {
		await dropSchema(driver, schema);
	}
	await driver.close();
	shared = undefined;
});

async function refusalOf(
	schema: string,
	id: string,
	sql: string,
): Promise<{ readonly code?: string }> {
	const driver = await connection();
	const plugin = {
		id,
		migrations: [{ version: 1, name: "reach", createsTables: [], sql }],
	} as unknown as VelvePlugin;
	return asMigrationRole(driver, async () => {
		try {
			return await createVelveAuth(
				configFor({ database: driver as Driver, schema, plugins: [plugin] }),
			)
				.migrate()
				.then(() => ({}))
				.catch((error: { code?: string }) => error);
		} catch (error) {
			return error as { code?: string };
		}
	});
}

async function relationExists(schema: string, name: string): Promise<boolean> {
	const rows = await (await connection()).query(
		`SELECT 1 FROM pg_class child
		 JOIN pg_namespace namespace_ ON namespace_.oid = child.relnamespace
		 WHERE namespace_.nspname = $1 AND child.relname = $2`,
		[schema, name],
	);
	return rows.length > 0;
}

async function triggerExists(schema: string, name: string): Promise<boolean> {
	const rows = await (await connection()).query(
		`SELECT 1 FROM pg_trigger trigger_
		 JOIN pg_class child ON child.oid = trigger_.tgrelid
		 JOIN pg_namespace namespace_ ON namespace_.oid = child.relnamespace
		 WHERE namespace_.nspname = $1 AND trigger_.tgname = $2`,
		[schema, name],
	);
	return rows.length > 0;
}

/**
 * The ownership predicate subtracted the core **table** names while the census walked every
 * relation there is, so a plugin id that prefixes a core index owned that index. Seventeen core
 * tables give eighteen prefix pairs and the thirty-four core relations that are not tables give
 * eighty-six more, none of which any list of table names reaches.
 */
describe("a core relation that is not a table (3.11)", () => {
	it("refuses a plugin called user_email the unique index one account per address rests on", async () => {
		const schema = await freshSchema();

		const refusal = await refusalOf(schema, "user_email", "DROP INDEX velve.user_email_key");

		expect(refusal.code).toBeDefined();
		expect(await relationExists(schema, "user_email_key")).toBe(true);
	});

	it("keeps one account per address after the migration that tried to drop its index", async () => {
		const schema = await freshSchema();
		const driver = await connection();
		await createUser(driver, schema, { email: "one@example.com" });

		await refusalOf(schema, "user_email", "DROP INDEX velve.user_email_key");

		await expect(createUser(driver, schema, { email: "one@example.com" })).rejects.toThrow();
	});

	it("refuses a plugin called session_user an index of velve.session", async () => {
		const schema = await freshSchema();

		const refusal = await refusalOf(schema, "session_user", "DROP INDEX velve.session_user_id_idx");

		expect(refusal.code).toBeDefined();
		expect(await relationExists(schema, "session_user_id_idx")).toBe(true);
	});

	it("refuses renaming a core index to a plugin that carries its prefix", async () => {
		const schema = await freshSchema();

		const refusal = await refusalOf(
			schema,
			"user_email",
			"ALTER INDEX velve.user_email_key RENAME TO user_email_key_moved",
		);

		expect(refusal.code).toBeDefined();
		expect(await relationExists(schema, "user_email_key")).toBe(true);
	});
});

/**
 * The removal check walked relations, and the code census reads what a transaction **created**. A
 * dropped trigger is in neither: its catalogue row is gone rather than written, and dropping it
 * does not rewrite the table's own row. S-FIX-2 puts half its enforcement in exactly such a
 * trigger, and `pnpm check:session-owner` scans this library's SQL rather than the database.
 */
describe("core code a migration removes rather than leaves behind (S-FIX-2)", () => {
	it("refuses dropping the trigger that refuses a session owner update", async () => {
		const schema = await freshSchema();

		const refusal = await refusalOf(
			schema,
			"audit",
			"DROP TRIGGER session_user_id_immutable ON velve.session",
		);

		expect(refusal.code).toBeDefined();
		expect(await triggerExists(schema, "session_user_id_immutable")).toBe(true);
	});

	it("refuses dropping the function that trigger calls, cascade and all", async () => {
		const schema = await freshSchema();

		const refusal = await refusalOf(
			schema,
			"audit",
			"DROP FUNCTION velve.reject_session_owner_update() CASCADE",
		);

		expect(refusal.code).toBeDefined();
		expect(await triggerExists(schema, "session_user_id_immutable")).toBe(true);
	});

	it("still refuses a session owner update after the migration that tried to allow it", async () => {
		const schema = await freshSchema();
		const driver = await connection();
		const owner = await createUser(driver, schema);
		const victim = await createUser(driver, schema);
		await driver.query(
			`INSERT INTO ${schema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at)
			 VALUES ($1, decode('aa', 'hex'), now() + interval '1 day', now() + interval '7 days')`,
			[owner],
		);

		await refusalOf(schema, "audit", "DROP TRIGGER session_user_id_immutable ON velve.session");

		await expect(
			driver.query(`UPDATE ${schema}.session SET user_id = $1`, [victim]),
		).rejects.toThrow();
	});
});

/**
 * A later migration of the same plugin may alter and drop what an earlier one of its own created,
 * so the snapshot has to exempt the plugin's own objects — and those are the ones that belong to
 * the tables it declared, which is a set the plugin cannot widen by choosing its id.
 */
describe("what a plugin may still do to what it created itself (3.11)", () => {
	it("lets a second migration drop an index the first one made on its own table", async () => {
		const schema = await freshSchema();
		const driver = await connection();

		const refusal = await asMigrationRole(driver, () =>
			createVelveAuth(
				configFor({
					database: driver as Driver,
					schema,
					plugins: [
						{
							id: "audit",
							migrations: [
								{
									version: 1,
									name: "create",
									createsTables: ["audit_entry"],
									sql: `CREATE TABLE velve.audit_entry (
									id uuid PRIMARY KEY,
									user_id uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE);
								CREATE INDEX audit_entry_user ON velve.audit_entry (user_id);`,
								},
								{
									version: 2,
									name: "drop_the_index",
									createsTables: [],
									sql: "DROP INDEX velve.audit_entry_user;",
								},
							],
						} as unknown as VelvePlugin,
					],
				}),
			)
				.migrate()
				.then(() => ({}) as { code?: string })
				.catch((error: { code?: string }) => error),
		);

		expect(refusal.code).toBeUndefined();
		expect(await relationExists(schema, "audit_entry")).toBe(true);
		expect(await relationExists(schema, "audit_entry_user")).toBe(false);
	});
});
