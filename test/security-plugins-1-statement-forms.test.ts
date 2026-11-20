import { describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { createOwnTables } from "../src/core/plugin/own-tables.js";

/**
 * S-OWNER-10: plugin SQL is one statement, and the check reads it the way PostgreSQL reads it or
 * refuses it. Every statement below is one that the check would erase as data while PostgreSQL
 * reads a core table, a second statement or both. A driver sends a statement without parameters
 * as a simple query, which may carry several, so a hidden `;` is a second statement on its own.
 */

function recordingDriver(reached: string[]): Driver {
	return {
		query: <T>(sql: string): Promise<T[]> => {
			reached.push(sql);
			return Promise.resolve([]);
		},
		transaction: <T>(work: (tx: Driver) => Promise<T>): Promise<T> =>
			work(recordingDriver(reached)),
	};
}

async function reaches(sql: string, databaseRole?: string): Promise<boolean> {
	const reached: string[] = [];
	const ownTables = createOwnTables({
		driver: recordingDriver(reached),
		schema: "velve",
		pluginId: "demo",
		...(databaseRole === undefined ? {} : { databaseRole }),
	});
	await ownTables.query(sql, []).catch(() => undefined);
	return reached.includes(sql);
}

describe("every literal form PostgreSQL reads is read alike or refused (S-OWNER-10)", () => {
	it("refuses an escape string whose backslash hides the closing quote", async () => {
		expect(await reaches("SELECT E'\\'', token_sha256 FROM velve.session --'")).toBe(false);
		expect(await reaches("SELECT e'\\'' FROM demo_entry; DELETE FROM velve.session --'")).toBe(
			false,
		);
	});

	it("refuses a backslash in a plain literal, which escapes with standard_conforming_strings off", async () => {
		expect(await reaches("SELECT '\\'' FROM demo_entry; DELETE FROM velve.session --'")).toBe(
			false,
		);
	});

	it("refuses an escape string even when it hides nothing", async () => {
		expect(await reaches("SELECT E'plain' FROM demo_entry")).toBe(false);
	});

	it("refuses a unicode escape string", async () => {
		expect(await reaches("SELECT U&'d\\0061t' FROM demo_entry")).toBe(false);
	});

	it("refuses a dollar-quoted string, tagged or not", async () => {
		expect(await reaches("SELECT $$ ' $$ FROM velve.session")).toBe(false);
		expect(await reaches("SELECT $q$ ' $q$, 1 FROM demo_entry")).toBe(false);
	});

	it("ends a line comment at a carriage return as PostgreSQL does", async () => {
		expect(await reaches("SELECT 1 FROM demo_entry --\r; DELETE FROM velve.session")).toBe(false);
		expect(await reaches("SELECT 1 FROM demo_entry --\rUNION SELECT 1 FROM velve.session")).toBe(
			false,
		);
	});

	it("refuses a semicolon anywhere, inside a literal and a comment included", async () => {
		expect(await reaches("SELECT ';' FROM demo_entry")).toBe(false);
		expect(await reaches("SELECT 1 FROM demo_entry /* ; */")).toBe(false);
		expect(await reaches("SELECT 1 FROM demo_entry -- ;")).toBe(false);
		expect(await reaches("SELECT 1 FROM demo_entry;")).toBe(false);
	});

	it("refuses the same forms when the statement would run under the plugin role", async () => {
		expect(
			await reaches("SELECT E'\\''; RESET ROLE; DELETE FROM velve.session; SELECT --'", "demo_role"),
		).toBe(false);
	});

	it("still lets a plain statement with doubled quotes and placeholders through", async () => {
		expect(await reaches("SELECT 'it''s', $1 FROM demo_entry WHERE note <> 'x'")).toBe(true);
		expect(await reaches("INSERT INTO demo_entry (note) VALUES ($1) -- a note\n")).toBe(true);
	});
});
