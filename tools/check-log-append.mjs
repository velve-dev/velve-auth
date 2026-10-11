import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const LOG = "docs/decisions/log.md";
/** Where the log lived at a merge base older than its move; its lines are what this branch may not delete. */
const LOG_BEFORE_THE_MOVE = "CASE-STUDY.md";
const BASE = process.env.VELVE_LOG_BASE ?? "origin/main";

/** CLAUDE.md §6: an entry that existed at the merge base is never edited. Zero deleted lines
 * is that rule in a form a script can read. The three-dot form is required — two-dot counts
 * deletions `main`'s own commits made as though this branch had made them (E-538). */
function git(argv) {
	return execFileSync("git", argv, {
		cwd: repositoryRoot,
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
	});
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

function existsAt(revision, path) {
	try {
		execFileSync("git", ["cat-file", "-e", `${revision}:${path}`], {
			cwd: repositoryRoot,
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

const logAtBase = [LOG, LOG_BEFORE_THE_MOVE].find((path) => existsAt(mergeBase, path));
if (logAtBase === undefined) {
	refuse(`neither ${LOG} nor ${LOG_BEFORE_THE_MOVE} is in the tree at the merge base`);
}

/** Blob against blob, so a branch that moves the log is held to every line the old path had. */
const compared = [`${mergeBase}:${logAtBase}`, `HEAD:${LOG}`];
const numstat = git(["diff", "--numstat", ...compared]).trim();
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

/**
 * CLAUDE.md §1 and §6 sanction one exception to zero deletions, the central pass that translates
 * the German entries (E-2990). A deleted line is excused only when the merge base shows it as part
 * of a German-form entry whose anchor HEAD still carries over an English entry of the same number
 * tagged as translated, or as part of the German file header or a German section heading. Every
 * other deleted line is a fault, exactly as before.
 */
const TRANSLATION_TAG = "translated from the German original";
const GERMAN_ENTRY_HEADING = /^\*\*(E-\d+) — /;
const ANCHOR = /^<a id="e-\d+"><\/a>$/;
/** A paragraph inside a German entry that already opens with an English bold label, such as
 * E-47's licence addendum, is English text the pass has no reason to delete. */
const ENGLISH_PARAGRAPH_INSIDE_A_GERMAN_ENTRY = /^\*\*(?!E-\d)[A-Z][^*]*\.\*\*/;
const GERMAN_HEADER_OPENING = "# Velve Auth — Fallstudie";
const SEPARATOR = "---";
const GERMAN_SECTION_HEADINGS = new Set([
	"### Laufzeit und Auslieferung",
	"### Datenbank",
	"### Kennwörter",
	"### Identität",
	"### Sitzungen",
	"### Zweiter Faktor",
	"### Drittanbieter",
	"### Erweiterbarkeit",
	"### Umfang",
	"### Migration",
	"### Sicherheit als Vorgabe",
	"## Entscheidungen aus dem Bau",
]);

function isBlank(line) {
	return line.trim() === "";
}

function nextNonBlank(lines, from) {
	for (let index = from; index < lines.length; index += 1) {
		if (!isBlank(lines[index])) return index;
	}
	return -1;
}

/** The entry an anchor opens, when the next line that is not blank is a German heading of its number. */
function germanEntryOpenedBy(lines, index) {
	const anchor = lines[index];
	const following = nextNonBlank(lines, index + 1);
	const german = following === -1 ? null : GERMAN_ENTRY_HEADING.exec(lines[following]);
	if (german === null || anchor !== `<a id="e-${german[1].slice(2)}"></a>`) return null;
	return { kind: "entry", number: german[1], anchor };
}

/** The region a line opens, null for a line that closes the one before, undefined for one that continues it. */
function regionOpenedBy(lines, index, current) {
	const line = lines[index];
	if (line === GERMAN_HEADER_OPENING) return { kind: "header" };
	if (GERMAN_SECTION_HEADINGS.has(line)) return { kind: "heading" };
	if (ANCHOR.test(line)) return germanEntryOpenedBy(lines, index);
	if (line.startsWith("#") || line === SEPARATOR) return null;
	const german = GERMAN_ENTRY_HEADING.exec(line);
	if (german !== null && german[1] !== current?.number) return null;
	return undefined;
}

/** The label of a line that continues the current entry; an English paragraph inside it is left unlabelled. */
function continuedEntryLabel(state, line) {
	state.inEnglishParagraph =
		!isBlank(line) &&
		(state.inEnglishParagraph || ENGLISH_PARAGRAPH_INSIDE_A_GERMAN_ENTRY.test(line));
	return state.inEnglishParagraph ? null : state.current;
}

/** The label of one line, advancing the state the walk over the log carries. */
function labelOf(state, lines, index) {
	const line = lines[index];
	if (state.current?.kind === "header") {
		const header = state.current;
		if (line === SEPARATOR) state.current = null;
		return header;
	}
	const opened = regionOpenedBy(lines, index, state.current);
	if (opened === undefined) {
		return state.current?.kind === "entry" ? continuedEntryLabel(state, line) : null;
	}
	state.current = opened?.kind === "heading" ? null : opened;
	state.inEnglishParagraph = false;
	return opened;
}

/** Each line of the log at the merge base, labelled with what the pass may replace it with. */
function migratableRegions(lines) {
	const state = { current: null, inEnglishParagraph: false };
	return lines.map((_, index) => labelOf(state, lines, index));
}

/** The anchors HEAD carries directly over a translated English entry, mapped to its number. */
function translatedAnchors(lines) {
	const anchors = new Map();
	for (let index = 0; index < lines.length; index += 1) {
		if (!ANCHOR.test(lines[index])) continue;
		const heading = nextNonBlank(lines, index + 1);
		if (heading === -1 || !lines[heading].startsWith("### ")) continue;
		const numberLine = /^`(E-\d+)` · [^·]+ · (.+)$/.exec(lines[heading + 1] ?? "");
		if (numberLine !== null && numberLine[2] === TRANSLATION_TAG) {
			anchors.set(lines[index], numberLine[1]);
		}
	}
	return anchors;
}

function excused(label, anchors) {
	if (label === null) return false;
	if (label.kind === "header" || label.kind === "heading") return true;
	return anchors.get(label.anchor) === label.number;
}

/** Base line numbers of every line the diff deletes, read from the hunk headers. */
function deletedLineNumbers() {
	const numbers = [];
	for (const line of git(["diff", "--unified=0", ...compared]).split("\n")) {
		const hunk = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
		if (hunk === null) continue;
		const start = Number(hunk[1]);
		const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
		for (let offset = 0; offset < count; offset += 1) numbers.push(start + offset);
	}
	return numbers;
}

let replacedByTranslation = 0;
if (deletions > 0) {
	const baseLines = git(["show", `${mergeBase}:${logAtBase}`]).split("\n");
	const labels = migratableRegions(baseLines);
	const anchors = translatedAnchors(git(["show", `HEAD:${LOG}`]).split("\n"));
	const lineExcused = (index) => excused(labels[index] ?? null, anchors);
	/** A blank line belongs to whichever neighbour the pass replaced, so it is excused with it. */
	const blankExcused = (index) => {
		let before = index - 1;
		while (before >= 0 && isBlank(baseLines[before])) before -= 1;
		const after = nextNonBlank(baseLines, index + 1);
		return (before >= 0 && lineExcused(before)) || (after !== -1 && lineExcused(after));
	};
	const removed = deletedLineNumbers().filter((number) => {
		const index = number - 1;
		const ok = isBlank(baseLines[index] ?? "") ? blankExcused(index) : lineExcused(index);
		if (ok) replacedByTranslation += 1;
		return !ok;
	});
	if (removed.length > 0) {
		console.error(
			`${LOG} loses ${removed.length} line${removed.length === 1 ? "" : "s"} that ${logAtBase} had at the merge base ${mergeBase.slice(0, 7)}.`,
		);
		console.error("CLAUDE.md §6: an entry that existed at the merge base is never edited.");
		console.error(
			"The one exception is the central translation pass, and none of these lines is a German entry, header or section heading replaced by its translation.",
		);
		for (const number of removed) console.error(`  ${number}: -${baseLines[number - 1]}`);
		process.exit(1);
	}
}

/** Zero deletions is satisfied by a branch that never opens the log, and §5's gate list asks
 * for the opposite — the log extended for the feature. Nothing else states that mechanically. */
if (commits > 0 && additions === 0) {
	console.error(`${LOG} gained no line across ${commits} commit${commits === 1 ? "" : "s"}.`);
	console.error("CLAUDE.md §5: the branch records the decisions it took before it merges.");
	process.exit(1);
}

const against = `${BASE} (merge base ${mergeBase.slice(0, 7)}, ${commits} commit${commits === 1 ? "" : "s"} ahead)`;
const translated =
	replacedByTranslation === 0
		? ""
		: `, all ${replacedByTranslation} deleted line${replacedByTranslation === 1 ? "" : "s"} German and replaced by translation`;
console.log(`log: ${LOG} +${additions} -${deletions} committed against ${against}${translated}`);
