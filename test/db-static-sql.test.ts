import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = new URL("../src/", import.meta.url);
const migrationModules = "core/db/migrations/";

function sourceFiles(directory: URL, prefix = ""): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			found.push(...sourceFiles(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`));
			continue;
		}
		if (entry.name.endsWith(".ts")) {
			found.push(`${prefix}${entry.name}`);
		}
	}
	return found;
}

interface SqlLiteral {
	readonly file: string;
	readonly sql: string;
}

const LITERAL = /`([^`]*)`|"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g;
const LOOKS_LIKE_SQL = /\b(SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i;

function sqlLiterals(): SqlLiteral[] {
	const found: SqlLiteral[] = [];
	for (const file of sourceFiles(sourceRoot)) {
		if (file.startsWith(migrationModules)) {
			continue;
		}
		const text = readFileSync(fileURLToPath(new URL(file, sourceRoot)), "utf8");
		for (const match of text.matchAll(LITERAL)) {
			const sql = match[1] ?? match[2] ?? match[3] ?? "";
			if (LOOKS_LIKE_SQL.test(sql)) {
				found.push({ file, sql });
			}
		}
	}
	return found;
}

describe("the statements written into the source (S-FIX-2, S-OWNER-2)", () => {
	it("finds statements to inspect at all, so a passing scan means something", () => {
		expect(sqlLiterals().length).toBeGreaterThan(5);
	});

	it("contains no statement that writes velve.session.user_id", () => {
		const offenders = sqlLiterals().filter((literal) =>
			/\bUPDATE\b[\s\S]*\bsession\b[\s\S]*\bSET\b[\s\S]*\buser_id\b/i.test(literal.sql),
		);

		expect(offenders).toEqual([]);
	});

	it("gives every row-changing statement an owner predicate", () => {
		const changing = sqlLiterals().filter((literal) =>
			/^\s*(DELETE\s+FROM|UPDATE)\b/i.test(literal.sql),
		);
		const withoutOwner = changing.filter(
			(literal) => !/\bWHERE\b[\s\S]*(\$\{ownerColumn\}|\buser_id\b)/i.test(literal.sql),
		);

		expect(changing.length).toBeGreaterThan(0);
		expect(withoutOwner).toEqual([]);
	});

	it("never reads a row before changing it, because no method issues two statements", () => {
		const repository = readFileSync(
			fileURLToPath(new URL("core/db/repositories/owned-row-repository.ts", sourceRoot)),
			"utf8",
		);
		const methods = [
			"findOwnedRow",
			"listOwnedRows",
			"updateOwnedRow",
			"deleteOwnedRow",
			"deleteAllOwnedRows",
		];

		for (const method of methods) {
			expect(repository).toContain(`${method}(`);
		}
		expect(repository.match(/options\.driver\.query/g)).toHaveLength(methods.length);
	});
});
