import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withoutComments } from "./source-text.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * CLAUDE.md §7: `velve.one_time_token` is ordered **before** `velve.user` everywhere. Four redeem
 * flows consume a token row to learn which account they act for, so they cannot lock the account
 * first; what keeps that safe is that no transaction takes the account row and *then* touches the
 * token table. E-1616 found that invariant held by a reading and by nothing else — the cycle it
 * would close is with every redemption in the library, and it passes `check:lock-order`, the cycle
 * analyser and every case in the tree.
 */
const LOCKS = ["lockAccountRow", "lockAccountRowStatement"];

/** The two repository methods and the flows' mint helper that writes through the table. */
const TOKEN_HELPERS = ["replaceOneTimeToken", "consumeOneTimeToken", "mintArtefact"];

/** An import names a symbol without calling it, and every import precedes every call. */
const IMPORT_STATEMENT = /^\s*import\s[\s\S]*?from\s*["'][^"']*["'];?\s*$/gm;

/** `import { mintArtefact as mint }` calls the helper as `mint(`, which the plain names miss. */
const RENAMED_IMPORT = /\b([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/g;

function localNamesOf(code, names) {
	const local = new Map(names.map((name) => [name, name]));
	for (const statement of code.match(IMPORT_STATEMENT) ?? []) {
		for (const [, imported, alias] of statement.matchAll(RENAMED_IMPORT)) {
			if (names.includes(imported)) {
				local.set(alias, imported);
			}
		}
	}
	return local;
}

function callOf(localNames) {
	return new RegExp(`\\b(${[...localNames.keys()].join("|")})\\s*\\(`, "g");
}

function patternsFor(source) {
	const code = withoutComments(source);
	const locks = localNamesOf(code, LOCKS);
	const helpers = localNamesOf(code, TOKEN_HELPERS);
	return {
		code: code.replaceAll(IMPORT_STATEMENT, ""),
		takesTheAccountRow: callOf(locks),
		helpers,
		reachesTheTokenTable: new RegExp(
			`\\bone_time_token\\b|\\b(${[...helpers.keys()].join("|")})\\s*\\(`,
			"g",
		),
	};
}

/** The table is created here, and a migration takes no account lock. */
const MIGRATIONS = /^src\/core\/db\/migrations\//;

/** Every module that reaches the token table is allowed to, and none of them may lock the account
 * row; that half is the scan below rather than a list. */
const SOURCE = /^src\/.*\.ts$/;

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
		.filter((path) => !MIGRATIONS.test(path));
}

/** Comments are stripped so that prose about the ordering — `lock.ts` carries the rule itself — is
 * not read as code, and imports so that naming a symbol is not reaching for it. */
export function tokenReachedAfterAccountLock(source) {
	const { code, takesTheAccountRow, helpers, reachesTheTokenTable } = patternsFor(source);
	const locks = [...code.matchAll(takesTheAccountRow)].map((match) => match.index ?? 0);
	if (locks.length === 0) {
		return [];
	}
	const firstLock = Math.min(...locks);
	return [...code.matchAll(reachesTheTokenTable)]
		.filter((match) => (match.index ?? 0) > firstLock)
		.map((match) => {
			const reached = String(match[0]).replace(/\s*\($/, "");
			return helpers.get(reached) ?? reached;
		});
}

export function scanTokenAfterLock() {
	const offenders = [];
	let filesScanned = 0;
	let locksScanned = 0;
	for (const path of sourceFiles()) {
		filesScanned += 1;
		const source = readFileSync(`${repositoryRoot}/${path}`, "utf8");
		const { code, takesTheAccountRow } = patternsFor(source);
		locksScanned += [...code.matchAll(takesTheAccountRow)].length;
		for (const reached of tokenReachedAfterAccountLock(source)) {
			offenders.push(`${path}: reaches ${reached} after taking the account row`);
		}
	}
	return { offenders, filesScanned, locksScanned };
}
