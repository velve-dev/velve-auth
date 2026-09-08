import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

const ROW_LOCK = /\bfor\s+(?:no\s+key\s+)?update\b/gi;
const SOURCE = /\.(m?[jt]sx?|c[jt]s|sql)$/;

/** Every repository builds its table name from the configured schema, so a scan cannot
 * read which table a lock takes. Naming tables was therefore passing for the absence of
 * a name rather than the presence of `user`. A locking statement now declares its target
 * instead, in a block comment that travels with it and cannot be collapsed away. */
const DECLARES_ITS_TARGET = /\/\*\s*locks:\s*([a-z_.${}]+)\s*\*\//i;
const THE_USER_TABLE = /(^|\.)user$/i;

function statementAround(sql, lockIndex) {
	const start = sql.lastIndexOf(";", lockIndex) + 1;
	const end = sql.indexOf(";", lockIndex);
	return sql.slice(start, end === -1 ? sql.length : end);
}

export function lockOrderViolations(sql) {
	const violations = [];
	for (const match of sql.matchAll(ROW_LOCK)) {
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
		.filter((path) => !path.startsWith("test/"));
}

export function scanLockOrder() {
	const offenders = [];
	let locksScanned = 0;
	for (const path of sourceFiles()) {
		const contents = readFileSync(`${repositoryRoot}/${path}`, "utf8");
		locksScanned += [...contents.matchAll(ROW_LOCK)].length;
		for (const violation of lockOrderViolations(contents)) {
			offenders.push(`${path}: ${violation}`);
		}
	}
	return { offenders, locksScanned };
}
