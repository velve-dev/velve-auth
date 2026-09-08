import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { splitStatements } from "../src/core/db/schema-rewrite.js";
import {
	examinedStatementsIn,
	literalsIn,
	onOneLine,
	runsPastItsEnd,
	statementsOf,
	survivesCollapsing,
	templateLiteralsIn,
	walkerFaults,
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

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/** Everything the walker is ever pointed at, which is wider than what the check scans. */
function walkedFiles(): string[] {
	return ["src", "test", "tools"].flatMap((directory) =>
		readdirSync(`${repositoryRoot}${directory}`, { recursive: true, withFileTypes: true })
			.filter(
				(entry) => entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs")),
			)
			.map((entry) => `${entry.parentPath}/${entry.name}`)
			.sort(),
	);
}

/** The second counter, deliberately not the walker: one regular expression over the two comment
 * forms, taking whichever opens first so a `//` inside a block comment does not end it early. */
function withoutTypeScriptComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
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

	// A regular expression is delimited like nothing else here, and a lone quote inside one put
	// every quote after it out of phase, so the literals behind it went unread (E-155).
	it("reads the template literal that follows a regular expression carrying a lone quote", () => {
		const source = [
			"const quoted = /[\"']/g;",
			"const q = `DELETE FROM t",
			"-- swallows the predicate",
			"WHERE id = $1`;",
		].join("\n");

		expect(templateLiteralsIn(source)).toHaveLength(1);
		expect(examinedStatementsIn(source)).toHaveLength(1);
		expect(survivesCollapsing(examinedStatementsIn(source)[0] ?? "")).toBe(false);
	});

	it("reads a division as a division rather than as a regular expression", () => {
		expect(literalsIn('const ratio = total / "one".length / 2;')).toStrictEqual(["one"]);
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

// A check that cannot see itself go blind is not a check. The walker skips comments to find
// literals, so an over-long skip reads nothing and reports a plausible count for source it
// never opened. Both assertions below are about the scan itself, not about any statement.
describe("the scan can tell that it read everything", () => {
	// TypeScript block comments do not nest, so a scanned one never holds another inside it.
	// This is the predicate the corpus assertion rests on; without it that assertion is empty.
	it("knows a comment that ran past its own end from one that stopped", () => {
		expect(runsPastItsEnd("/* documents the marker /* like this */")).toBe(false);
		expect(runsPastItsEnd("/* documents the marker /* like this */ and then some */")).toBe(true);
	});

	it("skips no comment past its own end anywhere in the tree", () => {
		const faults = walkedFiles().flatMap((path) =>
			walkerFaults(readFileSync(path, "utf8")).map((fault) => `${path}: ${fault}`),
		);
		expect(faults).toStrictEqual([]);
	});

	// Counted a second way, sharing nothing with the walker but the two comment forms: a backtick
	// that no comment encloses opens a template literal, and a walker that reported none walked
	// over one. E-155 corrected both halves of that sentence.
	it("finds a template literal in every file that has a backtick outside a comment", () => {
		const carriesABacktick = walkedFiles().filter((path) =>
			withoutTypeScriptComments(readFileSync(path, "utf8")).includes("`"),
		);
		const missed = carriesABacktick.filter(
			(path) => templateLiteralsIn(readFileSync(path, "utf8")).length === 0,
		);

		expect(walkedFiles().length).toBeGreaterThan(50);
		expect(carriesABacktick.length).toBeGreaterThan(50);
		expect(missed).toStrictEqual([]);
	});

	// The premise of the assertion above, planted: a file whose backticks are all inside a block
	// comment holds no template literal, so asking it for one reports a fault where none is.
	it("asks nothing of a file whose only backticks are inside a block comment", () => {
		const source = "/* the marker is written `like this` */\nexport const limit = 1;\n";

		expect(source).toContain("`");
		expect(withoutTypeScriptComments(source)).not.toContain("`");
		expect(literalsIn(source)).toStrictEqual([]);
	});

	it("reads the literal that follows a block comment holding a comment opener", () => {
		const source = [
			"/* documents the marker /* like this */",
			"const q = `DELETE FROM t",
			"-- swallows the predicate",
			"WHERE id = $1`;",
		].join("\n");

		expect(literalsIn(source)).toHaveLength(1);
		expect(examinedStatementsIn(source)).toHaveLength(1);
		expect(survivesCollapsing(examinedStatementsIn(source)[0] ?? "")).toBe(false);
	});
});
