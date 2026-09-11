import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chunksOf } from "./source-text.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/** The schema is configurable, so a repository writes `UPDATE ${table} SET …` and the
 * word `session` never appears. Requiring the table name made this blind to the one
 * module it exists to police, so it now reads the assignment list of any UPDATE.
 * Reassigning an owner is wrong on every table, not only on this one. */
const WRITES_ROWS = /\b(update|merge\s+into|on\s+conflict)\b/i;
const ASSIGNMENT_LIST = /\bset\b([\s\S]*?)(?:\bwhere\b|\breturning\b|\bfrom\b|$)/i;
const OWNER_COLUMN = /\buser_id\b/i;

/** Comments are dropped but string bodies are kept: dynamic SQL lives inside quotes,
 * so removing them would hide exactly what this looks for. The walker is shared with the
 * scans that read `src/` for statements, which used to read whole file text (E-1653). */
export function statementsIn(source, lineCommentOpener = "//") {
	const statements = [];
	let current = "";
	for (const chunk of chunksOf(source, lineCommentOpener)) {
		if (chunk.kind !== "code") {
			current += chunk.kind === "comment" ? " " : chunk.text;
			continue;
		}
		const [first = "", ...rest] = chunk.text.split(";");
		current += first;
		for (const part of rest) {
			statements.push(current);
			current = part;
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

/** The advice is about prose that is not in a comment, which is the only thing a source offender
 * can be: `statementsIn` drops comments before anything is matched. A built module carries no
 * prose, so offering it there tells a reader to edit generated output. */
function adviceFor(sourceOffenders) {
	return sourceOffenders.length > 0
		? ["If this is prose describing the rule, move it into a comment."]
		: [];
}

/**
 * What this step found, kept apart from what it could not look at. Both used to leave by the same
 * door: with no dist/ at all the step printed the security message, named no offender and exited 1,
 * so an absent build arrived looking like a violation of S-FIX-2 and cost a round (E-1624).
 */
export function reportOn(source, built) {
	const refusals = [];
	if (source.statementsScanned === 0) {
		refusals.push(
			"S-FIX-2: refusing to report. No statement was read from the working tree, so the scan could not look. This is not a finding.",
		);
	}
	if (!built.built) {
		refusals.push(
			"S-FIX-2: refusing to report. dist/ holds no built module, so what ships was not scanned. This is not a finding — run pnpm build, which pnpm check:session-owner does for you.",
		);
	}
	const offenders = [...source.offenders, ...built.offenders];
	const findings =
		offenders.length > 0
			? [
					"S-FIX-2: a session owner is reassigned in SQL. Re-issue is INSERT plus DELETE (E-23).",
					...offenders.map((offender) => `  ${offender}`),
					...adviceFor(source.offenders),
				]
			: [];
	return {
		refusals,
		findings,
		summary: `S-FIX-2: ${source.statementsScanned} source and ${built.statementsScanned} built statements scanned, no session owner reassignment`,
		exitCode: refusals.length + findings.length > 0 ? 1 : 0,
	};
}
