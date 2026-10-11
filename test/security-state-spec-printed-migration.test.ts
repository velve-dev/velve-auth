import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

//the ddl of migration 3 printed in section 3.18 is the shipped one in both languages (E-3376)

function statementWithoutComments(sql: string): string {
	return sql
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/--[^\n]*/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

const shipped = statementWithoutComments(
	readFileSync(new URL("../migrations/0003_security_state.sql", import.meta.url), "utf8"),
);

describe.each([
	["German", "../VELVE-AUTH-ARCHITEKTUR.md"],
	["English", "../VELVE-AUTH-ARCHITECTURE.md"],
])("the %s specification", (_name, file) => {
	it("prints the CREATE TABLE of migration 3 as the shipped file has it", () => {
		const text = readFileSync(new URL(file, import.meta.url), "utf8");
		const start = text.indexOf("-- Migration 3");
		const end = text.indexOf("-- Migration 4", start);
		expect(start).toBeGreaterThan(-1);
		expect(statementWithoutComments(text.slice(start, end).replace("-- Migration 3", ""))).toBe(
			shipped,
		);
	});
});
