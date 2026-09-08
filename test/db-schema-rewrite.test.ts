import { describe, expect, it } from "vitest";
import { initialSchema } from "../src/core/db/migrations/initial-schema.js";
import { applySchemaName } from "../src/core/db/schema-rewrite.js";

const target = "velve_other";

function rewrite(sql: string): string {
	return applySchemaName(sql, target);
}

describe("renaming the schema in a shipped statement", () => {
	it("returns the statement untouched when the name already matches", () => {
		expect(applySchemaName(initialSchema.sql, "velve")).toBe(initialSchema.sql);
	});

	it("renames a qualifier", () => {
		expect(rewrite("SELECT * FROM velve.session")).toBe(`SELECT * FROM ${target}.session`);
		expect(rewrite("SELECT * FROM VELVE.session")).toBe(`SELECT * FROM ${target}.session`);
	});

	it("renames the schema a statement creates, drops or alters", () => {
		expect(rewrite("CREATE SCHEMA IF NOT EXISTS velve;")).toBe(
			`CREATE SCHEMA IF NOT EXISTS ${target};`,
		);
		expect(rewrite("DROP SCHEMA velve CASCADE;")).toBe(`DROP SCHEMA ${target} CASCADE;`);
	});

	it("leaves a string literal alone", () => {
		expect(rewrite("INSERT INTO velve.t (s) VALUES ('velve');")).toBe(
			`INSERT INTO ${target}.t (s) VALUES ('velve');`,
		);
		expect(rewrite("SELECT 'it''s velve'")).toBe("SELECT 'it''s velve'");
	});

	it("leaves a column, a quoted identifier and a longer name alone", () => {
		expect(rewrite("CREATE TABLE velve.t (velve text)")).toBe(
			`CREATE TABLE ${target}.t (velve text)`,
		);
		expect(rewrite('SELECT "velve" FROM velve.t')).toBe(`SELECT "velve" FROM ${target}.t`);
		expect(rewrite("SELECT velve_id FROM velve.t")).toBe(`SELECT velve_id FROM ${target}.t`);
	});

	it("leaves a comment alone, because it is prose and not a statement", () => {
		expect(rewrite("-- velve.user is the identity\nSELECT 1")).toBe(
			"-- velve.user is the identity\nSELECT 1",
		);
		expect(rewrite("/* velve /* velve */ velve */ SELECT velve.x")).toBe(
			`/* velve /* velve */ velve */ SELECT ${target}.x`,
		);
	});

	it("leaves a dollar-quoted body alone", () => {
		expect(rewrite("CREATE FUNCTION velve.f() RETURNS void AS $$ SELECT 'velve' $$;")).toBe(
			`CREATE FUNCTION ${target}.f() RETURNS void AS $$ SELECT 'velve' $$;`,
		);
		expect(rewrite("SELECT $body$ velve.user $body$")).toBe("SELECT $body$ velve.user $body$");
	});

	it("leaves a placeholder and another schema's qualifier alone", () => {
		expect(rewrite("SELECT * FROM public.velve WHERE id = $1")).toBe(
			"SELECT * FROM public.velve WHERE id = $1",
		);
	});

	it("renames every qualifier in the shipped migration and nothing else", () => {
		const rewritten = rewrite(initialSchema.sql);

		expect(rewritten).not.toContain("velve.");
		expect(rewritten).toContain(`${target}.session`);
		expect(rewritten).toContain(`CREATE SCHEMA IF NOT EXISTS ${target};`);
	});
});

describe("string literals the first scanner mis-read", () => {
	it("leaves an E-string with a backslash-escaped quote alone", () => {
		expect(rewrite("SELECT E'it\\'s velve', velve.x")).toBe(`SELECT E'it\\'s velve', ${target}.x`);
	});

	it("does not treat a backslash as an escape in an ordinary string", () => {
		expect(rewrite("SELECT 'a\\', velve.x")).toBe(`SELECT 'a\\', ${target}.x`);
	});

	it("reads a dollar quote that follows a keyword without a space", () => {
		expect(rewrite("CREATE FUNCTION velve.f() RETURNS void AS$$SELECT 'velve'$$;")).toBe(
			`CREATE FUNCTION ${target}.f() RETURNS void AS$$SELECT 'velve'$$;`,
		);
	});
});
