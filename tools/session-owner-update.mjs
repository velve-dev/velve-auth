import { readdirSync, readFileSync, statSync } from "node:fs";

const SESSION_TABLE = /\b(?:velve\s*\.\s*)?session\b/i;
const SETS_OWNER = /\bset\b[\s\S]*\buser_id\b/i;
const REASSIGNMENT = [
	/\bupdate\b[\s\S]*?\bsession\b[\s\S]*?\bset\b[\s\S]*?\buser_id\b/i,
	/\binsert\s+into\b[\s\S]*?\bsession\b[\s\S]*?\bon\s+conflict\b[\s\S]*?\bdo\s+update\b[\s\S]*?\buser_id\b/i,
	/\bmerge\s+into\b[\s\S]*?\bsession\b[\s\S]*?\bupdate\s+set\b[\s\S]*?\buser_id\b/i,
];

function withoutLiteralsAndComments(sql) {
	let out = "";
	let index = 0;
	while (index < sql.length) {
		const rest = sql.slice(index);
		const quoted = /^'(?:[^']|'')*'/.exec(rest);
		if (quoted) {
			out += "''";
			index += quoted[0].length;
			continue;
		}
		if (rest.startsWith("/*")) {
			const end = sql.indexOf("*/", index + 2);
			out += " ";
			index = end === -1 ? sql.length : end + 2;
			continue;
		}
		if (rest.startsWith("--") || rest.startsWith("//")) {
			const end = sql.indexOf("\n", index);
			out += " ";
			index = end === -1 ? sql.length : end;
			continue;
		}
		out += sql[index];
		index += 1;
	}
	return out;
}

export function reassignsSessionOwner(statement) {
	const sql = withoutLiteralsAndComments(statement);
	if (!SESSION_TABLE.test(sql) || !SETS_OWNER.test(sql)) return false;
	return REASSIGNMENT.some((pattern) => pattern.test(sql));
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
			const contents = withoutLiteralsAndComments(readFileSync(path, "utf8"));
			for (const statement of contents.split(";")) {
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
