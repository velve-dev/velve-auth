import { describe, expect, it } from "vitest";
import { onOneLine, survivesCollapsing, withoutSqlComments } from "../tools/sql-collapse.mjs";
import fixtures from "./fixtures/sql-collapse.json" with { type: "json" };

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
