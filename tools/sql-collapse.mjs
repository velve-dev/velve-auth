import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

const SOURCE_ROOT = "src";

/** The migration modules hold whole scripts rather than statements, and the runner cuts them
 * on `;` before any of them reaches a driver. They carry the same shape and are deferred, not
 * cleared; the count is printed so the exemption stays visible. */
const HOLDS_A_SCRIPT_NOT_A_STATEMENT = /^src\/core\/db\/migrations\//;

const LITERAL = /`([^`]*)`|"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g;
const LOOKS_LIKE_SQL = /\b(SELECT|INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP)\b/i;

/** A `'…'` body is data: `--` inside one opens no comment, and `''` is an escaped quote. */
function endOfSqlString(sql, index) {
	let cursor = index + 1;
	while (cursor < sql.length) {
		if (sql[cursor] !== "'") {
			cursor += 1;
			continue;
		}
		if (sql[cursor + 1] === "'") {
			cursor += 2;
			continue;
		}
		return cursor + 1;
	}
	return sql.length;
}

export function withoutSqlComments(sql) {
	let stripped = "";
	let index = 0;
	while (index < sql.length) {
		if (sql[index] === "'") {
			const end = endOfSqlString(sql, index);
			stripped += sql.slice(index, end);
			index = end;
		} else if (sql.startsWith("/*", index)) {
			const close = sql.indexOf("*/", index + 2);
			stripped += " ";
			index = close === -1 ? sql.length : close + 2;
		} else if (sql.startsWith("--", index)) {
			const newline = sql.indexOf("\n", index);
			stripped += " ";
			index = newline === -1 ? sql.length : newline;
		} else {
			stripped += sql[index];
			index += 1;
		}
	}
	return stripped;
}

/** What a logger, a formatter or a fronting proxy leaves of a statement. */
export function onOneLine(sql) {
	return sql.replace(/\s+/g, " ").trim();
}

/** E-266: a comment that runs to the end of its line takes everything after it the moment the
 * newlines are gone, so removing the comments has to give the same statement either way round.
 * A block comment ends in the text and survives; a line comment ends in a newline and does not. */
export function survivesCollapsing(sql) {
	return onOneLine(withoutSqlComments(onOneLine(sql))) === onOneLine(withoutSqlComments(sql));
}

function sourceFiles(directory, prefix) {
	return readdirSync(`${repositoryRoot}/${directory}`, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => `${entry.parentPath}/${entry.name}`.replace(`${repositoryRoot}/`, ""))
		.filter((path) => path.startsWith(prefix))
		.sort();
}

function statementsIn(source) {
	return [...source.matchAll(LITERAL)]
		.map((match) => match[1] ?? match[2] ?? match[3] ?? "")
		.filter((literal) => LOOKS_LIKE_SQL.test(literal));
}

export function scanSqlCollapse() {
	const offenders = [];
	let statementsScanned = 0;
	let filesDeferred = 0;

	for (const path of sourceFiles(SOURCE_ROOT, SOURCE_ROOT)) {
		if (HOLDS_A_SCRIPT_NOT_A_STATEMENT.test(path)) {
			filesDeferred += 1;
			continue;
		}
		for (const statement of statementsIn(readFileSync(`${repositoryRoot}/${path}`, "utf8"))) {
			statementsScanned += 1;
			if (!survivesCollapsing(statement)) {
				offenders.push(
					`${path}: ${onOneLine(withoutSqlComments(onOneLine(statement))) || "(the whole statement)"}`,
				);
			}
		}
	}

	return { offenders, statementsScanned, filesDeferred };
}
