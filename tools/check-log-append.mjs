import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const LOG = "CASE-STUDY.md";
const BASE = process.env.VELVE_LOG_BASE ?? "origin/main";

/** CLAUDE.md §6: an entry that existed at the merge base is never edited. Zero deleted lines
 * is that rule in a form a script can read. The three-dot form is required — two-dot counts
 * deletions `main`'s own commits made as though this branch had made them (E-538). */
function git(argv) {
	return execFileSync("git", argv, { cwd: repositoryRoot, encoding: "utf8" });
}

function refuse(reason, detail) {
	console.error(`The decision log cannot be checked: ${reason}`);
	if (detail !== undefined) console.error(`  ${detail}`);
	process.exit(1);
}

function resolved(revision) {
	try {
		return git(["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]).trim();
	} catch {
		return "";
	}
}

const head = resolved("HEAD");
if (head === "") {
	refuse("HEAD names no commit");
}

const base = resolved(BASE);
if (base === "") {
	refuse(
		`the base ${BASE} names no commit here`,
		"fetch it, or name another with VELVE_LOG_BASE — a run that cannot compute the base is not a pass",
	);
}

let mergeBase = "";
try {
	mergeBase = git(["merge-base", base, "HEAD"]).trim();
} catch {
	mergeBase = "";
}
if (mergeBase === "") {
	refuse(
		`${BASE} and HEAD share no common ancestor`,
		"the branch was not cut from that base, so what predates it cannot be told from what does not",
	);
}

try {
	git(["cat-file", "-e", `HEAD:${LOG}`]);
} catch {
	refuse(`${LOG} is not in the tree at HEAD`, "the log is the file this rule is about");
}

const numstat = git(["diff", `${BASE}...HEAD`, "--numstat", "--", LOG]).trim();
const rows = numstat.split("\n").filter(Boolean);
if (rows.length > 1) {
	refuse(`the diff of ${LOG} reports ${rows.length} paths`, numstat.replace(/\n/g, " | "));
}

const [added, deleted] = (rows[0] ?? "0\t0\t").split("\t");
if (added === "-" || deleted === "-") {
	refuse(`${LOG} is diffed as binary, so its lines cannot be counted`);
}

const additions = Number(added);
const deletions = Number(deleted);
const commits = Number(git(["rev-list", "--count", `${mergeBase}..HEAD`]).trim());

if (deletions > 0) {
	const removed = git(["diff", `${BASE}...HEAD`, "--", LOG])
		.split("\n")
		.filter((line) => line.startsWith("-") && !line.startsWith("---"));
	console.error(
		`${LOG} loses ${deletions} line${deletions === 1 ? "" : "s"} that existed at the merge base ${mergeBase.slice(0, 7)}.`,
	);
	console.error("CLAUDE.md §6: an entry that existed at the merge base is never edited.");
	for (const line of removed) console.error(`  ${line}`);
	process.exit(1);
}

/** Zero deletions is satisfied by a branch that never opens the log, and §5's gate list asks
 * for the opposite — the log extended for the feature. Nothing else states that mechanically. */
if (commits > 0 && additions === 0) {
	console.error(`${LOG} gained no line across ${commits} commit${commits === 1 ? "" : "s"}.`);
	console.error("CLAUDE.md §5: the branch records the decisions it took before it merges.");
	process.exit(1);
}

const against = `${BASE} (merge base ${mergeBase.slice(0, 7)}, ${commits} commit${commits === 1 ? "" : "s"} ahead)`;
console.log(`log: ${LOG} +${additions} -0 committed against ${against}`);
