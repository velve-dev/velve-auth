import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/** Every mode PostgreSQL can be asked for explicitly, not only the two the previous version of this
 * scan could see. `FOR SHARE` and `FOR KEY SHARE` were invisible to it: a planted `FOR SHARE` on
 * `velve.session` with no marker passed at exit 0 (E-1609). */
const ROW_LOCK = /\bFOR\s+(NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b/gi;

/** CLAUDE.md §7: `FOR NO KEY UPDATE` is the one mode this library takes, because it is the strongest
 * that does not conflict with the `FOR KEY SHARE` a foreign key takes on `velve.user` for every
 * insert of a user-owned row. A stronger mode turns that implicit acquisition into an edge no reader
 * sees in the SQL, which is what one of the two reproduced deadlocks was made of (E-1601, E-1604). */
const THE_PERMITTED_MODE = "no key update";

/** One row lock, in one file, so the mode cannot vary between call sites. Every other module reaches
 * it through `lockAccountRow` or `lockAccountRowStatement`. */
const THE_FILE_THAT_WRITES_THE_LOCK = "src/core/db/lock.ts";

const SOURCE = /\.(m?[jt]sx?|c[jt]s|sql)$/;

/** This scan and the step that runs it have to name the modes they refuse, the way CLAUDE.md §4
 * exempts the attribution check from its own rule. Nothing under `tools/` writes SQL. */
const THE_CHECK_ITSELF = /^tools\//;

/** Every repository builds its table name from the configured schema, so a scan cannot read which
 * table a lock takes. Naming tables was therefore passing for the absence of a name rather than the
 * presence of `user`. A locking statement declares its target instead, in a block comment that
 * travels with it and cannot be collapsed away. */
const DECLARES_ITS_TARGET = /\/\*\s*locks:\s*([a-z_.${}]+)\s*\*\//i;
const THE_USER_TABLE = /(^|\.)user$/i;

function statementAround(sql, lockIndex) {
	const start = sql.lastIndexOf(";", lockIndex) + 1;
	const end = sql.indexOf(";", lockIndex);
	return sql.slice(start, end === -1 ? sql.length : end);
}

function normalisedMode(matched) {
	return matched.toLowerCase().replaceAll(/\s+/g, " ");
}

export function lockOrderViolations(sql) {
	const violations = [];
	for (const match of sql.matchAll(ROW_LOCK)) {
		const mode = normalisedMode(String(match[1]));
		if (mode !== THE_PERMITTED_MODE) {
			violations.push(`a row lock taken FOR ${mode.toUpperCase()}`);
			continue;
		}
		const statement = statementAround(sql, match.index ?? 0);
		const declared = DECLARES_ITS_TARGET.exec(statement)?.[1];
		if (declared === undefined) {
			violations.push("a row lock that does not declare what it locks");
		} else if (!THE_USER_TABLE.test(declared.replace(/\$\{[^}]*\}/g, "").replace(/\.$/, ""))) {
			violations.push(`a row lock on ${declared}`);
		}
	}
	return violations;
}

/**
 * The string literals of a source file, with comments skipped. A row lock only ever appears inside
 * SQL and SQL is always a string here, so scanning whole files reads prose about a lock as a lock —
 * and a backtick span in a doc comment reads as a template literal, which is what a regular
 * expression over the whole file got wrong (E-1609). The `/* locks: … *\/` marker lives inside the
 * SQL string and survives, because by then the walk is inside a string and not looking for comments.
 */
function sqlTextIn(path, contents) {
	if (path.endsWith(".sql")) {
		return [contents];
	}
	const found = [];
	let index = 0;
	while (index < contents.length) {
		const here = contents[index];
		const next = contents[index + 1];
		if (here === "/" && next === "/") {
			while (index < contents.length && contents[index] !== "\n") index += 1;
			continue;
		}
		if (here === "/" && next === "*") {
			index += 2;
			while (index < contents.length && !(contents[index] === "*" && contents[index + 1] === "/")) {
				index += 1;
			}
			index += 2;
			continue;
		}
		if (here === '"' || here === "'" || here === "`") {
			let end = index + 1;
			while (end < contents.length && contents[end] !== here) {
				end += contents[end] === "\\" ? 2 : 1;
			}
			found.push(contents.slice(index + 1, end));
			index = end + 1;
			continue;
		}
		index += 1;
	}
	return found;
}

function sourceFiles() {
	const listed = execFileSync(
		"git",
		["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
		{ cwd: repositoryRoot, encoding: "utf8" },
	);
	return listed
		.split("\0")
		.filter(Boolean)
		.filter((path) => SOURCE.test(path))
		.filter((path) => !path.startsWith("test/"))
		.filter((path) => !THE_CHECK_ITSELF.test(path));
}

export function scanLockOrder() {
	const offenders = [];
	let filesScanned = 0;
	let locksScanned = 0;
	for (const path of sourceFiles()) {
		filesScanned += 1;
		const contents = readFileSync(`${repositoryRoot}/${path}`, "utf8");
		for (const sql of sqlTextIn(path, contents)) {
			const locks = [...sql.matchAll(ROW_LOCK)].length;
			locksScanned += locks;
			if (locks > 0 && path !== THE_FILE_THAT_WRITES_THE_LOCK) {
				offenders.push(`${path}: a row lock outside ${THE_FILE_THAT_WRITES_THE_LOCK}`);
			}
			for (const violation of lockOrderViolations(sql)) {
				offenders.push(`${path}: ${violation}`);
			}
		}
	}
	return { offenders, filesScanned, locksScanned };
}
