import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const SKILLS = ["CLAUDE-SKILL.md", "CODEX-SKILL.md"];
const BASE = process.env.VELVE_SKILL_BASE ?? "origin/main";
const VERSION_LINE = /^\*\*Skill version (\d+) · (\d{4}-\d{2}-\d{2})\*\*$/m;

/** CLAUDE.md §6: every change to a skill file raises its version, so that the session check
 * can tell a current file from a stale one. Reads committed history, like check-log-append. */
function git(argv) {
	return execFileSync("git", argv, { cwd: repositoryRoot, encoding: "utf8" });
}

function refuse(reason, detail) {
	console.error(`The skill version cannot be checked: ${reason}`);
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

function blob(revision, path) {
	try {
		return git(["show", `${revision}:${path}`]);
	} catch {
		return null;
	}
}

if (resolved("HEAD") === "") {
	refuse("HEAD names no commit");
}

const base = resolved(BASE);
if (base === "") {
	refuse(
		`the base ${BASE} names no commit here`,
		"fetch it, or name another with VELVE_SKILL_BASE — a run that cannot compute the base is not a pass",
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

const findings = [];
const scanned = [];
const lineAtHead = new Map();

for (const skill of SKILLS) {
	const now = blob("HEAD", skill);
	if (now === null) {
		refuse(`${skill} is not in the tree at HEAD`, "the version rule is about both skill files");
	}

	const current = VERSION_LINE.exec(now);
	if (current === null) {
		refuse(
			`${skill} carries no "**Skill version <n> · <yyyy-mm-dd>**" line at HEAD`,
			"a version that cannot be read is not a version that did not change",
		);
	}
	lineAtHead.set(skill, current[0]);

	const before = blob(mergeBase, skill);
	if (before === null) {
		scanned.push(`${skill} new against the merge base, at version ${current[1]}`);
		continue;
	}
	if (before === now) {
		scanned.push(`${skill} unchanged, at version ${current[1]}`);
		continue;
	}

	const previous = VERSION_LINE.exec(before);
	if (previous === null) {
		scanned.push(`${skill} changed, version none → ${current[1]}`);
		continue;
	}
	if (Number(current[1]) > Number(previous[1])) {
		scanned.push(`${skill} changed, version ${previous[1]} → ${current[1]}`);
		continue;
	}
	findings.push(
		`${skill} changed against the merge base and its version did not rise: still ${previous[1]}.`,
	);
}

const [claude, codex] = SKILLS;
if (lineAtHead.get(claude) !== lineAtHead.get(codex)) {
	findings.push(
		`${claude} and ${codex} state different versions: "${lineAtHead.get(claude)}" against "${lineAtHead.get(codex)}".`,
	);
}

if (findings.length > 0) {
	for (const finding of findings) console.error(finding);
	console.error(
		"CLAUDE.md §6: the skill is the fourth file kept current, and every change to it raises its version.",
	);
	process.exit(1);
}

const against = `${BASE} (merge base ${mergeBase.slice(0, 7)})`;
console.log(`skill version: ${scanned.join("; ")} — committed against ${against}`);
