import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

const SESSION_TABLE = /\b(?:velve\s*\.\s*)?session\b/i;
const SETS_OWNER = /\bset\b[\s\S]*\buser_id\b/i;
const REASSIGNMENT = [
	/\bupdate\b[\s\S]*?\bsession\b[\s\S]*?\bset\b[\s\S]*?\buser_id\b/i,
	/\binsert\s+into\b[\s\S]*?\bsession\b[\s\S]*?\bon\s+conflict\b[\s\S]*?\bdo\s+update\b[\s\S]*?\buser_id\b/i,
	/\bmerge\s+into\b[\s\S]*?\bsession\b[\s\S]*?\bupdate\s+set\b[\s\S]*?\buser_id\b/i,
];

const QUOTES = new Set(["'", '"', "`"]);

function endOfBlockComment(source, index) {
	const close = source.indexOf("*/", index + 2);
	return close === -1 ? source.length : close + 2;
}

function endOfLineComment(source, index) {
	const newline = source.indexOf("\n", index);
	return newline === -1 ? source.length : newline;
}

function endOfQuoted(source, index) {
	const quote = source[index];
	let cursor = index + 1;
	while (cursor < source.length) {
		if (source[cursor] === "\\") {
			cursor += 2;
			continue;
		}
		if (source[cursor] !== quote) {
			cursor += 1;
			continue;
		}
		if (quote === "'" && source[cursor + 1] === "'") {
			cursor += 2;
			continue;
		}
		return cursor + 1;
	}
	return source.length;
}

/** `--` opens a comment in SQL but is a decrement in TypeScript, and `//` the
 * reverse, so the file's language decides which one blinds the scanner. */
function commentEndsAt(source, index, lineCommentOpener) {
	if (source.startsWith("/*", index)) return endOfBlockComment(source, index);
	if (source.startsWith(lineCommentOpener, index)) return endOfLineComment(source, index);
	return null;
}

/** Comments are dropped but string bodies are kept: dynamic SQL lives inside quotes,
 * so removing them would hide exactly what this looks for. */
export function statementsIn(source, lineCommentOpener = "//") {
	const statements = [];
	let current = "";
	let index = 0;
	while (index < source.length) {
		const commentEnd = commentEndsAt(source, index, lineCommentOpener);
		if (commentEnd !== null) {
			current += " ";
			index = commentEnd;
		} else if (QUOTES.has(source[index])) {
			const quotedEnd = endOfQuoted(source, index);
			current += source.slice(index, quotedEnd);
			index = quotedEnd;
		} else if (source[index] === ";") {
			statements.push(current);
			current = "";
			index += 1;
		} else {
			current += source[index];
			index += 1;
		}
	}
	statements.push(current);
	return statements;
}

export function reassignsSessionOwner(statement) {
	if (!SESSION_TABLE.test(statement) || !SETS_OWNER.test(statement)) return false;
	return REASSIGNMENT.some((pattern) => pattern.test(statement));
}

/** Naming every extension that might execute is an unbounded list; naming the
 * files that only describe the rule is a short one. No executable file is exempt:
 * this detector's own cases live in a JSON fixture precisely so none has to be. */
const DESCRIBES_THE_RULE = new Set([
	"VELVE-AUTH-ARCHITEKTUR.md",
	"CASE-STUDY.md",
	"CLAUDE.md",
	"DOCUMENTATION.md",
	"README.md",
	"test/fixtures/session-owner-sql.json",
]);
const NOT_TEXT = /^assets\//;
const HASH_COMMENT = /\.(sh|bash|zsh|ksh|ya?ml|py|rb|toml)$/;
const DOUBLE_DASH_COMMENT = /\.(sql|psql|pgsql|ddl)$/;

function lineCommentOpenerFor(path) {
	if (DOUBLE_DASH_COMMENT.test(path)) return "--";
	if (HASH_COMMENT.test(path)) return "#";
	return "//";
}

function executableSourceFiles() {
	const listed = execFileSync(
		"git",
		["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
		{ cwd: repositoryRoot, encoding: "utf8" },
	);
	return listed
		.split("\0")
		.filter(Boolean)
		.filter((path) => !NOT_TEXT.test(path))
		.filter((path) => !DESCRIBES_THE_RULE.has(path));
}

export function scanTree() {
	const offenders = [];
	let statementsScanned = 0;
	for (const path of executableSourceFiles()) {
		const opener = lineCommentOpenerFor(path);
		for (const statement of statementsIn(
			readFileSync(`${repositoryRoot}/${path}`, "utf8"),
			opener,
		)) {
			if (!/\b(update|merge)\b/i.test(statement)) continue;
			statementsScanned += 1;
			if (reassignsSessionOwner(statement)) {
				offenders.push(`${path}: ${statement.trim().replace(/\s+/g, " ").slice(0, 120)}`);
			}
		}
	}
	return { offenders, statementsScanned };
}
