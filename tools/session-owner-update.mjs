import { readdirSync, readFileSync, statSync } from "node:fs";

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

function commentEndsAt(source, index) {
	const pair = source.slice(index, index + 2);
	if (pair === "/*") return endOfBlockComment(source, index);
	if (pair === "//" || pair === "--") return endOfLineComment(source, index);
	return null;
}

/** Comments are dropped but string bodies are kept: dynamic SQL lives inside quotes,
 * so removing them would hide exactly what this looks for. */
export function statementsIn(source) {
	const statements = [];
	let current = "";
	let index = 0;
	while (index < source.length) {
		const commentEnd = commentEndsAt(source, index);
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

function sourceFiles(directory, found = []) {
	for (const entry of readdirSync(directory)) {
		const path = `${directory}/${entry}`;
		if (statSync(path).isDirectory()) sourceFiles(path, found);
		else if (/\.(ts|mts|mjs|sql)$/.test(entry)) found.push(path);
	}
	return found;
}

export function scanTree(directories) {
	const offenders = [];
	let statementsScanned = 0;
	for (const directory of directories) {
		for (const path of sourceFiles(directory)) {
			for (const statement of statementsIn(readFileSync(path, "utf8"))) {
				if (!/\b(update|merge)\b/i.test(statement)) continue;
				statementsScanned += 1;
				if (reassignsSessionOwner(statement)) {
					offenders.push(`${path}: ${statement.trim().replace(/\s+/g, " ").slice(0, 120)}`);
				}
			}
		}
	}
	return { offenders, statementsScanned };
}
