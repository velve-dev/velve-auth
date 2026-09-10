import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const DETECTOR = ".github/workflows/ci.yml";
const BASE = process.env.VELVE_ATTRIBUTION_BASE ?? "origin/main";
const MAX_OUTPUT = 256 * 1024 * 1024;

/** CLAUDE.md §4 exempts three files and says nothing else is, so this script keeps no copy of
 * the patterns: it reads them out of the detector, which is one of the three. A copy here would
 * be a fourth path needing exemption, which is the repair E-1429 measured and refused. */
const ASSISTANT_LIST = /^[ \t]*ASSISTANTS: '([^']+)'$/m;
const EXEMPT_LIST = /^[ \t]*EXEMPT=\(([^)]*)\)$/m;
const SINGLE_QUOTED = /'([^']*)'/g;
const SHELL_ESCAPE = /\\(["$`\\])/g;
const UNEXPANDED_VARIABLE = /\$[A-Za-z_]/;

function refuse(reason, detail) {
	console.error(`The attribution scan cannot be run: ${reason}`);
	if (detail !== undefined) {
		console.error(`  ${detail}`);
	}
	process.exit(1);
}

function run(argv) {
	return execFileSync("git", argv, {
		cwd: repositoryRoot,
		encoding: "utf8",
		maxBuffer: MAX_OUTPUT,
	});
}

/** Each scan reads its surface before searching it, so that the producer's own failure is a
 * refusal rather than an empty surface the search then reports nothing against. */
function surface(what, argv) {
	try {
		return run(argv);
	} catch (error) {
		refuse(`the ${what} scan could not read what it searches`, String(error));
	}
}

/** A surface that came back empty is the second way a scan reports success without having
 * looked at anything. The branch diff is the one surface below that is legitimately empty. */
function required(what, contents) {
	if (contents.length === 0) {
		refuse(`the ${what} scan had nothing to search`);
	}
	return contents;
}

function resolved(revision) {
	try {
		return run(["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]).trim();
	} catch {
		return "";
	}
}

/** `grep` exits 1 where it looked and matched nothing, 2 where it could not look, and a binary
 * that is not there gives neither. Only the first of the three is an answer, and what says which
 * is the status: a search that matched is a finding whether or not it printed a line, so reading
 * emptiness of output for it would let a producer that answers 0 and nothing through. */
function searched(what, command, argv, options) {
	try {
		const hits = execFileSync(command, argv, {
			encoding: "utf8",
			maxBuffer: MAX_OUTPUT,
			...options,
		});
		return { matched: true, hits };
	} catch (error) {
		if (error.status === 1) {
			return { matched: false, hits: "" };
		}
		/** The failing command is named by its status and never by its argument vector, which
		 * would print the pattern this file exists in order not to state. */
		const detail = String(error.stderr ?? "").trim();
		refuse(
			`the ${what} scan could not run, so it proves nothing`,
			detail || `${command} exited ${String(error.status ?? error.code)}`,
		);
	}
}

function detectorSource() {
	try {
		return readFileSync(`${repositoryRoot}${DETECTOR}`, "utf8");
	} catch (error) {
		refuse(`${DETECTOR} could not be read`, String(error));
	}
}

function stated(source, shape, what) {
	const found = shape.exec(source);
	if (found === null) {
		refuse(
			`${DETECTOR} states no ${what} in a form this script can read`,
			"a rewording it can no longer find is a refusal and not a pass",
		);
	}
	return String(found[1]);
}

function shellValue(name) {
	return new RegExp(`^[ \\t]*${name}="(.+)"$`, "m");
}

function expanded(raw, assistants, what) {
	const value = raw.replace(SHELL_ESCAPE, "$1").split("$ASSISTANTS").join(assistants);
	const unexpanded = UNEXPANDED_VARIABLE.exec(value);
	if (unexpanded !== null) {
		/** The variable is named and the value is not: a refusal that prints the derived pattern
		 * states it in a second place, which is the whole thing this script is built to avoid. */
		refuse(
			`${DETECTOR}'s ${what} names a shell variable this script does not expand`,
			`${unexpanded[0]}… at offset ${unexpanded.index} — the pattern itself is not printed here`,
		);
	}
	return value;
}

/** Proof that a pattern read out of the detector still matches what it is for: a bad unescaping
 * yields one that matches nothing, and a scan carrying it reports a clean tree. The assistant
 * name is taken from the detector at run time, so this file states no marker of its own — and
 * this file is not an exempt path, so a probe that ever came to carry one reddens this scan. */
function proves(what, pattern, probe) {
	if (!searched(`${what} self-test`, "grep", ["-Eani", "-e", pattern], { input: probe }).matched) {
		refuse(
			`the ${what} read from ${DETECTOR} matches nothing it is meant to match`,
			"the detector's patterns changed shape, or this script's probe for them is stale",
		);
	}
}

const source = detectorSource();
const assistants = stated(source, ASSISTANT_LIST, "assistant list");
const markers = expanded(
	stated(source, shellValue("MARKERS"), "marker pattern"),
	assistants,
	"marker pattern",
);
const claims = expanded(
	stated(source, shellValue("CLAIMS"), "claim pattern"),
	assistants,
	"claim pattern",
);
const exemptions = [...stated(source, EXEMPT_LIST, "exempt path list").matchAll(SINGLE_QUOTED)].map(
	(match) => String(match[1]),
);
if (exemptions.length === 0) {
	refuse(
		`${DETECTOR} lists no exempt path`,
		"§4 exempts three files, and a list this script reads as empty is a list it failed to read",
	);
}

const assistant = String(assistants.split("|")[0]);
proves("marker pattern", markers, `Co-authored-by: ${assistant}`);
proves("claim pattern", claims, `written by ${assistant}`);

if (resolved("HEAD") === "") {
	refuse("HEAD names no commit");
}
if (resolved(BASE) === "") {
	refuse(
		`the base ${BASE} names no commit here`,
		"fetch it, or name another with VELVE_ATTRIBUTION_BASE — a run that cannot compute the base is not a pass",
	);
}

/** A range selecting no commit cannot be told from a range that could not be read, so the
 * branch range is taken only where the branch has commits of its own, exactly as the detector
 * does; unlike the detector, an unresolvable base is refused rather than fallen back from. */
const ahead = Number(surface("commit range", ["rev-list", "--count", `${BASE}..HEAD`]).trim());
const range = ahead > 0 ? `${BASE}..HEAD` : "HEAD";
const commits = Number(surface("commit range", ["rev-list", "--count", range]).trim());
if (commits === 0) {
	refuse(`the range ${range} selects no commit, so the history scans read nothing`);
}

const findings = [];

function report(finding, result) {
	if (result.matched) {
		findings.push(`${finding}\n${result.hits.trimEnd()}`);
	}
}

function treeScan(pattern) {
	return searched("tree", "git", ["grep", "-Eani", "-e", pattern, "--", ".", ...exemptions], {
		cwd: repositoryRoot,
	});
}

const messages = required(
	"commit message",
	surface("commit message", ["log", "--format=%B", range]),
);
report(
	`AI attribution found in the commit messages of ${range}`,
	searched("commit message", "grep", ["-Eani", "-e", `${markers}|${claims}`], { input: messages }),
);

const tracked = required("tree", surface("tree", ["ls-files", "--", ".", ...exemptions]));
report("AI attribution marker found in the tree", treeScan(markers));
report("AI authorship claim found in the tree", treeScan(claims));

/** The tree scan cannot see text a later commit removed and the diff scan cannot see text that
 * predates the branch, so both run. A branch whose every change is in an exempt path leaves
 * this surface legitimately empty; what proves the scan looked is the commit count above. */
const diff = surface("branch diff", [
	"log",
	"-p",
	"--text",
	"--format=%B",
	range,
	"--",
	".",
	...exemptions,
]);
report(
	`AI attribution found in the diff of ${range}`,
	searched("branch diff", "grep", ["-Eani", "-e", `${markers}|${claims}`], { input: diff }),
);

if (findings.length > 0) {
	for (const finding of findings) {
		console.error(finding);
	}
	console.error(
		"CLAUDE.md §4: nothing here refers to an assistant, a model or a coding session. Reword it.",
	);
	process.exit(1);
}

const files = tracked.split("\n").filter(Boolean).length;
console.log(
	`attribution: ${commits} commit messages in ${range}, ${files} tracked files and ${diff.length} bytes of diff searched with ${DETECTOR}'s own patterns, no finding`,
);
