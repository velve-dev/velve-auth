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

	/** A statement that genuinely has no actor to filter on says so in its own text,
	 * citing the requirement that permits it. A marker travels with the statement, so
	 * it survives an interpolated schema name — which the table name does not.
	 *
	 * A block comment, because a line comment swallows everything to the next newline:
	 * `DELETE FROM t -- marker\nWHERE id = $1` becomes `DELETE FROM t` the moment any
	 * logger or proxy normalises the whitespace, and an unqualified DELETE is a worse
	 * failure than the one the marker exists to explain. */
	const DECLARES_NO_ACTOR = /\/\*\s*no owner predicate:\s*S-[A-Z]+-\d+[^*]*\*\//i;

	/** `FOR UPDATE` locks rows; it changes none. */
	const CHANGES_ROWS = /(?<!\bFOR\s{1,20})\b(DELETE\s+FROM|UPDATE)\b/i;

	it("gives every row-changing statement an owner predicate", () => {
		// Unanchored: a data-modifying CTE begins WITH, and still writes rows.
		const changing = sqlLiterals().filter((literal) => CHANGES_ROWS.test(literal.sql));
		const withoutOwner = changing
			.filter((literal) => !DECLARES_NO_ACTOR.test(literal.sql))
			.filter((literal) => {
				// RETURNING user_id is a result column, not a predicate.
				const predicate = literal.sql.split(/\bRETURNING\b/i)[0] ?? "";
				return !/\bWHERE\b[\s\S]*(\$\{ownerColumn\}|\buser_id\b)/i.test(predicate);
			});

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
