import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { splitStatements } from "../src/core/db/schema-rewrite.js";
import {
	examinedStatementsIn,
	literalsIn,
	onOneLine,
	statementsOf,
	survivesCollapsing,
	withoutSqlComments,
} from "../tools/sql-collapse.mjs";
import fixtures from "./fixtures/sql-collapse.json" with { type: "json" };

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(): string[] {
	return readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => `${entry.parentPath}/${entry.name}`)
		.sort();
}

const cases = (name: keyof typeof fixtures) =>
	fixtures[name].map(([label, sql]) => [label, sql] as [string, string]);

describe("sql collapse", () => {
	it.each(cases("permitted"))("keeps %s whole", (_label, sql) => {
		expect(survivesCollapsing(sql)).toBe(true);
	});

	it.each(cases("forbidden"))("refuses %s", (_label, sql) => {
		expect(survivesCollapsing(sql)).toBe(false);
	});

	// The same marker in the two comment forms, so a passing scan is evidence that the check
	// tells them apart rather than that it accepts everything (E-266).
	it("tells a line comment from a block comment carrying the same words", () => {
		const statement = "DELETE FROM t\nMARKER\nWHERE token_sha256 = $1";
		const asLineComment = statement.replace("MARKER", "-- no owner predicate: S-TOKEN-4");
		const asBlockComment = statement.replace("MARKER", "/* no owner predicate: S-TOKEN-4 */");

		expect(survivesCollapsing(asLineComment)).toBe(false);
		expect(survivesCollapsing(asBlockComment)).toBe(true);
		expect(withoutSqlComments(onOneLine(asLineComment))).not.toContain("token_sha256");
		expect(withoutSqlComments(onOneLine(asBlockComment))).toContain("token_sha256");
	});
});

// A migration is a script, and the runner cuts it here and keeps the comments, so the piece a
// driver receives carries the comment that precedes it (E-268).
describe("the unit a driver is handed", () => {
	it("gives a leading comment to the statement that follows it", () => {
		const script = "CREATE SCHEMA velve;\n-- explains the next one\nCREATE TABLE velve.user ();";
		const statements = statementsOf(script);

		expect(statements).toHaveLength(2);
		expect(statements[1]).toContain("-- explains the next one");
		expect(survivesCollapsing(statements[0] ?? "")).toBe(true);
		expect(survivesCollapsing(statements[1] ?? "")).toBe(false);
		expect(withoutSqlComments(onOneLine(statements[1] ?? ""))).not.toContain("CREATE TABLE");
	});

	it("ends no statement on a semicolon inside a string or a dollar-quoted body", () => {
		expect(statementsOf("SELECT ';' FROM t; SELECT 2")).toHaveLength(2);
		expect(statementsOf("CREATE FUNCTION f() AS $$ BEGIN RETURN 1; END $$; SELECT 1")).toHaveLength(
			2,
		);
	});
});

describe("what the scan reaches", () => {
	// A fragment with no SELECT or INSERT in it is still interpolated into a statement, and a
	// line comment inside one truncates that statement exactly as it would anywhere else.
	it("examines a keyword-less fragment once it carries a line comment", () => {
		const withComment = "const x = `to_char(expires_at,\n-- the agreed shape\n'YYYY')`;";
		const withoutComment = "const x = `to_char(expires_at, 'YYYY')`;";

		expect(examinedStatementsIn(withComment)).toHaveLength(1);
		expect(examinedStatementsIn(withoutComment)).toStrictEqual([]);
		expect(survivesCollapsing(examinedStatementsIn(withComment)[0] ?? "")).toBe(false);
	});

	// A pair of backticks is the wrong boundary: a template inside `${…}` closes it early and
	// everything after the nested one goes unexamined.
	it("reads a template literal past a nested one in its own interpolation", () => {
		const dollar = "$";
		const source = [
			"const q = `DELETE FROM ",
			dollar,
			"{`",
			dollar,
			"{a}.b`}",
			" WHERE id = $1\n-- and this`;",
		].join("");
		const literals = literalsIn(source);

		expect(literals).toHaveLength(1);
		expect(literals[0]).toContain("WHERE id = $1");
		expect(literals[0]).toContain("-- and this");
	});

	it("reads nothing out of a comment in the surrounding TypeScript", () => {
		expect(literalsIn('// const q = "SELECT 1";\nconst n = 1;')).toStrictEqual([]);
		expect(literalsIn('/* const q = "SELECT 1"; */\nconst n = 1;')).toStrictEqual([]);
	});
});

// The guarantee rests on reading the same regions the migration runner reads, so the claim is
// checked against the runner itself rather than restated (E-268).
describe("the regions this reads are the regions the runner reads", () => {
	const adversarial: [string, string][] = [
		["a nested block comment", "SELECT 1 /* outer /* in */ ; hidden */ FROM t; SELECT 2"],
		["a backslash escape inside E'…'", "SELECT E'a\\';SELECT 2' ; SELECT 3"],
		["a plain quote, where a backslash escapes nothing", "SELECT 'a\\' ; SELECT 2"],
		["an unterminated dollar quote", "SELECT 1 FROM t WHERE a = $$ AND b = 2"],
		["an unterminated tagged dollar quote", "SELECT 1 FROM t WHERE a = $tag$ AND b = 2"],
		[
			"a balanced dollar-quoted body holding a semicolon",
			"CREATE FUNCTION f() AS $$ a; b $$; SELECT 1",
		],
		["an unterminated block comment", "SELECT 1; /* never closed"],
		["an unterminated string", "SELECT 'never closed; SELECT 2"],
	];

	it.each(adversarial)("cuts %s where the runner cuts it", (_label, sql) => {
		expect(statementsOf(sql).map((statement) => statement.trim())).toStrictEqual(
			splitStatements(sql).map((statement) => statement.trim()),
		);
	});

	it("returns rather than looping on an unterminated dollar quote", () => {
		expect(statementsOf("SELECT 1 FROM t WHERE a = $$ AND b = 2")).toHaveLength(1);
		expect(statementsOf("SELECT 1 FROM t WHERE a = $tag$ AND b = 2")).toHaveLength(1);
	});

	it("cuts every SQL literal this repository ships exactly where the runner does", () => {
		const literals = sourceFiles().flatMap((path) => literalsIn(readFileSync(path, "utf8")));
		expect(literals.length).toBeGreaterThan(20);

		const disagreements = literals.filter(
			(literal) =>
				JSON.stringify(statementsOf(literal).map((statement) => statement.trim())) !==
				JSON.stringify(splitStatements(literal).map((statement) => statement.trim())),
		);
		expect(disagreements).toStrictEqual([]);
	});
});
