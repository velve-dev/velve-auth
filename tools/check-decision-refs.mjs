import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chunksOf } from "./source-text.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

const REQUIREMENTS = "VELVE-AUTH-ARCHITECTURE.md";
/** The curated case study and the complete log it is drawn from; the second may not exist yet. */
const DECISION_LOGS = ["CASE-STUDY.md", "docs/decisions/log.md"];

/** Every identifier anywhere in a comment is checked, so nesting and line breaks hide none. */
const IDENTIFIER = /\b(S-[A-Z]+-\d+|E-\d+)\b/g;
/** A bracket that opens like a citation and holds nothing this scan can resolve. */
const BRACKETED_CANDIDATE = /\(([SE]-[^()\s]*)\)/g;
const WHOLE_IDENTIFIER = /^(?:S-[A-Z]+-\d+|E-\d+)$/;

/** A requirement is defined by the list item that states it, not by the tables that cite it. */
const REQUIREMENT_DEFINITION = /^- \*\*(S-[A-Z]+-\d+):\*\*/gm;
/** The two entry forms test/decision-log.test.ts accepts, and only those. */
const DECISION_DEFINITIONS = [/^\*\*E-(\d+) — /gm, /^`E-(\d+)` · /gm];

function read(path) {
	return readFileSync(`${repositoryRoot}/${path}`, "utf8");
}

/** E-01 and E-1 name the same decision, and S-TIM-01 and S-TIM-1 the same requirement, so numbers
 * are compared and not spellings. */
function canonical(identifier) {
	return identifier.replace(/\d+$/, (number) => String(Number(number)));
}

function definedRequirements() {
	return new Set(
		[...read(REQUIREMENTS).matchAll(REQUIREMENT_DEFINITION)].map((m) => canonical(m[1])),
	);
}

function definedDecisions() {
	const defined = new Set();
	for (const path of DECISION_LOGS.filter((p) => existsSync(`${repositoryRoot}/${p}`))) {
		const log = read(path);
		for (const form of DECISION_DEFINITIONS) {
			for (const match of log.matchAll(form)) defined.add(`E-${Number(match[1])}`);
		}
	}
	return defined;
}

function sourceFiles() {
	const listed = execFileSync(
		"git",
		["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "src"],
		{ cwd: repositoryRoot, encoding: "utf8" },
	);
	return listed
		.split("\0")
		.filter((path) => path.endsWith(".ts") && !path.includes(".test."))
		.filter((path) => existsSync(`${repositoryRoot}/${path}`));
}

function lineAt(source, offset) {
	return source.slice(0, offset).split("\n").length;
}

/** Only comment text is read, so an identifier inside a string or an error message is not a citation. */
function referencesIn(path) {
	const source = read(path);
	const citations = [];
	const malformed = [];
	let offset = 0;
	for (const chunk of chunksOf(source)) {
		if (chunk.kind === "comment") {
			for (const match of chunk.text.matchAll(IDENTIFIER)) {
				const line = lineAt(source, offset + match.index);
				citations.push({ path, line, identifier: match[1] });
			}
			for (const match of chunk.text.matchAll(BRACKETED_CANDIDATE)) {
				if (!WHOLE_IDENTIFIER.test(match[1])) {
					malformed.push({ path, line: lineAt(source, offset + match.index), text: match[0] });
				}
			}
		}
		offset += chunk.text.length;
	}
	return { citations, malformed };
}

const files = sourceFiles();
const requirements = definedRequirements();
const decisions = definedDecisions();

/** Each of these looks exactly like a tree whose every citation resolves, which is what CLAUDE.md §5
 * asks a check to tell apart from a clean result. */
if (files.length === 0) {
	console.error("Decision references cannot be checked: no source file was read.");
	process.exit(1);
}
if (requirements.size === 0) {
	console.error(
		`Decision references cannot be checked: ${REQUIREMENTS} defined no S- requirement.`,
	);
	process.exit(1);
}
if (decisions.size === 0) {
	console.error(
		`Decision references cannot be checked: ${DECISION_LOGS.join(" and ")} defined no E- entry.`,
	);
	process.exit(1);
}

const references = files.map(referencesIn);
const citations = references.flatMap((found) => found.citations);
const malformed = references.flatMap((found) => found.malformed);
if (citations.length === 0) {
	console.error("Decision references cannot be checked: no comment in src/ cites anything.");
	process.exit(1);
}

const dead = citations.filter(({ identifier }) => {
	const known = identifier.startsWith("S-") ? requirements : decisions;
	return !known.has(canonical(identifier));
});

if (malformed.length > 0) {
	console.error("A comment brackets something shaped like a citation that is not an identifier:");
	for (const { path, line, text } of malformed) console.error(`  ${path}:${line} — ${text}`);
	console.error("A citation is one S-CLASS-n requirement or one E-n decision in parentheses.");
	process.exit(1);
}

if (dead.length > 0) {
	console.error("A comment cites an identifier that no document defines:");
	for (const { path, line, identifier } of dead) console.error(`  ${path}:${line} — ${identifier}`);
	console.error(
		`S- identifiers are defined in ${REQUIREMENTS}, E- identifiers in ${DECISION_LOGS.join(" or ")}.`,
	);
	process.exit(1);
}

console.log(
	`decision refs: ${citations.length} citations in ${files.length} files, every one defined (${requirements.size} requirements, ${decisions.size} decisions)`,
);
