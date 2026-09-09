import { describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { createOwnTables } from "../src/core/plugin/own-tables.js";

interface RecordingDriver extends Driver {
	readonly reached: readonly string[];
}

/**
 * The question is which statements reach the driver at all, so this one records and answers nothing.
 * A statement that gets here has passed the boundary 3.15 G draws, whatever it would have done next.
 */
function recordingDriver(): RecordingDriver {
	const reached: string[] = [];
	return {
		reached,
		query: <T>(sql: string): Promise<T[]> => {
			reached.push(sql);
			return Promise.resolve([]);
		},
		transaction: <T>(fn: (tx: Driver) => Promise<T>): Promise<T> => fn(recordingDriver()),
	};
}

async function reachedTheDriver(statements: readonly string[]): Promise<readonly string[]> {
	const driver = recordingDriver();
	const ownTables = createOwnTables({ driver, schema: "velve", pluginId: "demo" });
	for (const sql of statements) {
		await ownTables.query(sql, []).catch(() => undefined);
	}
	return driver.reached;
}

describe("what ownTables lets through to the driver (3.11, 3.15 G)", () => {
	it("lets a statement naming only the plugin's own tables through", async () => {
		const own = [
			"SELECT * FROM demo_entry",
			"SELECT * FROM velve.demo_entry",
			"INSERT INTO demo_entry (note) VALUES ($1)",
			"UPDATE velve.demo_entry SET note = $1",
			"DELETE FROM demo_entry",
			"SELECT * FROM demo_a a JOIN demo_b b ON b.id = a.id",
		];

		expect(await reachedTheDriver(own)).toStrictEqual(own);
	});

	it("stops a statement naming a core table in a position it understands", async () => {
		const foreign = [
			"SELECT * FROM velve.user",
			"UPDATE velve.session SET user_id = $1",
			"DELETE FROM velve.password_credential",
			"INSERT INTO velve.recovery_code (user_id) VALUES ($1)",
			"SELECT * FROM demo_entry d JOIN velve.totp_credential t ON t.user_id = d.id",
		];

		expect(await reachedTheDriver(foreign)).toStrictEqual([]);
	});

	/**
	 * E-751: a check that reports nothing found as nothing wrong is the failure mode `CLAUDE.md` §5
	 * names. Every statement below writes or reads a core table and none of them puts an identifier
	 * where the scan looks, so all five reach the driver.
	 */
	it("stops a statement naming a core table in a position it does not understand", async () => {
		const foreign = [
			'SELECT * FROM "velve"."user"',
			'INSERT INTO "velve"."user" (email) VALUES ($1)',
			"TRUNCATE velve.user CASCADE",
			"DROP TABLE velve.session",
			"COPY velve.password_credential TO STDOUT",
		];

		expect(await reachedTheDriver(foreign)).toStrictEqual([]);
	});

	/**
	 * E-770: the position walk is documented as incomplete (E-762), so the statements that matter are the
	 * ones putting a core table where no walk looks: a qualified column reference, a cast target, a
	 * clause after the table list. What refuses them is the name rule, and the assertion is the
	 * refusal rather than which rule produced it.
	 */
	it("stops a core table named where no table walk looks", async () => {
		const foreign = [
			"SELECT velve.user.id FROM demo_entry",
			"SELECT session.id FROM demo_entry",
			"SELECT $1::velve.recovery_code FROM demo_entry",
			"SELECT * FROM demo_entry ORDER BY velve.password_credential.phc",
			"WITH x AS (SELECT 1) SELECT velve.totp_credential.secret_enc FROM demo_entry",
			"SELECT velve.other_plugin_entry.note FROM demo_entry",
		];

		expect(await reachedTheDriver(foreign)).toStrictEqual([]);
	});

	/**
	 * The four shapes the review was asked to probe: a statement kind, a lateral, a function and a
	 * CTE. Two of these reach no core table and are refused anyway — a lateral and a
	 * set-returning function sit where a table sits and are none — so the array is what the
	 * boundary refuses and not what is foreign (E-782).
	 */
	it("stops a MERGE, a lateral, a set-returning function and a CTE that shadows a core name", async () => {
		const refused = [
			"MERGE INTO demo_entry USING demo_other ON true WHEN MATCHED THEN DO NOTHING",
			"MERGE INTO velve.user USING demo_entry ON true WHEN MATCHED THEN DO NOTHING",
			"SELECT * FROM demo_entry d, LATERAL (SELECT id FROM velve.session) s",
			"SELECT * FROM demo_entry d, LATERAL (SELECT 1) s",
			"SELECT * FROM json_to_recordset((SELECT to_json(u) FROM velve.user u)) AS x(id uuid)",
			"SELECT * FROM generate_series(1, 3)",
			'WITH "user" AS (SELECT 1) SELECT * FROM "user"',
			"WITH demo_x AS (SELECT * FROM velve.user) SELECT * FROM demo_x",
		];

		expect(await reachedTheDriver(refused)).toStrictEqual([]);
	});

	/** A core table reached through the quoting the position walk used to lose entirely (E-751). */
	it("stops a quoted, spaced or comment-split core table name", async () => {
		const foreign = [
			'SELECT * FROM "velve"."user"',
			'INSERT INTO "velve"."user" (email) VALUES ($1)',
			"SELECT * FROM velve . user",
			"SELECT * FROM velve/*x*/.user",
			'SELECT * FROM "velve"./*x*/"session"',
		];

		expect(await reachedTheDriver(foreign)).toStrictEqual([]);
	});

	it("names the plugin and the schema it is bounded to when it refuses", async () => {
		const ownTables = createOwnTables({
			driver: recordingDriver(),
			schema: "velve",
			pluginId: "demo",
		});

		await expect(ownTables.query("SELECT * FROM velve.user", [])).rejects.toThrow(
			/plugin demo may reach tables named demo_… in schema velve/,
		);
	});
});
