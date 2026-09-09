import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/** The schema is configurable, so a repository writes `UPDATE ${table} SET …` and the
 * word `session` never appears. Requiring the table name made this blind to the one
 * module it exists to police, so it now reads the assignment list of any UPDATE.
 * Reassigning an owner is wrong on every table, not only on this one. */
const WRITES_ROWS = /\b(update|merge\s+into|on\s+conflict)\b/i;
const ASSIGNMENT_LIST = /\bset\b([\s\S]*?)(?:\bwhere\b|\breturning\b|\bfrom\b|$)/i;
const OWNER_COLUMN = /\buser_id\b/i;

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
	if (!WRITES_ROWS.test(statement)) return false;
	const assignments = ASSIGNMENT_LIST.exec(statement)?.[1];
	return assignments !== undefined && OWNER_COLUMN.test(assignments);
}

/** The requirement is that the library never reassigns a session owner, so the
 * scan covers what ships and what runs against a database. Tests are excluded on
 * purpose: proving the trigger refuses the statement means writing the statement,
 * and a scan that forbade that would forbid testing the rule. Prose about the
 * rule is excluded for the same reason. */
const PROVES_OR_DESCRIBES_THE_RULE =
	/^(test\/|VELVE-AUTH-ARCHITEKTUR\.md$|VELVE-AUTH-ARCHITECTURE\.md$|CASE-STUDY\.md$|CLAUDE\.md$|CLAUDE-SKILL\.md$|CODEX-SKILL\.md$|DOCUMENTATION\.md$|README\.md$)/;
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
		.filter((path) => !PROVES_OR_DESCRIBES_THE_RULE.test(path))
		.filter((path) => lstatSync(`${repositoryRoot}/${path}`, { throwIfNoEntry: false })?.isFile());
}

/** Source layout cannot prove what ships: a file under test/ re-exported from src/
 * reaches dist/ like any other. S-FIX-2 is a claim about the library, so the built
 * artefact is what settles it. */
function builtFiles(directory) {
	const found = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = `${directory}/${entry.name}`;
		if (entry.isDirectory()) found.push(...builtFiles(path));
		else if (/\.(mjs|d\.mts)$/.test(entry.name)) found.push(path);
	}
	return found;
}

export function scanBuiltPackage() {
	const distribution = `${repositoryRoot}/dist`;
	const files = existsSync(distribution) ? builtFiles(distribution) : [];
	// Declarations alone are what an interrupted build leaves behind, not a build.
	const built = files.some((path) => path.endsWith(".mjs"));
	if (!built) return { offenders: [], statementsScanned: 0, built: false };
	const offenders = [];
	let statementsScanned = 0;
	for (const path of files) {
		for (const statement of statementsIn(readFileSync(path, "utf8"))) {
			if (!/\b(update|merge)\b/i.test(statement)) continue;
			statementsScanned += 1;
			if (reassignsSessionOwner(statement)) {
				offenders.push(
					`${path.replace(`${repositoryRoot}/`, "")}: ${statement.trim().replace(/\s+/g, " ").slice(0, 120)}`,
				);
			}
		}
	}
	return { offenders, statementsScanned, built };
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
