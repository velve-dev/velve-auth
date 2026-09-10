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
const SHELL_ESCAPED = new Set(['"', "$", "`", "\\"]);
const EXPANDED_HERE = "ASSISTANTS";

/** The forms of expansion this script knows bash performs inside a double-quoted value, read in
 * one pass so that no expansion hides behind a spelling of another: a backslash escape, a braced
 * name, a bare name, and the command substitutions, both arithmetic forms — `$(( ))` and the
 * older `$[ ]` — and the positional parameters it performs none of and refuses by name. A `$`
 * that is a regular expression's end-of-line anchor matches none of these alternatives and is
 * left where it stands.
 *
 * This is an enumeration and not a proof, and it has twice been found short by a reader rather
 * than by anything that runs: `${…}` was missing until E-1476 and `$[…]` until E-1484. A
 * spelling missing from it is performed by the detector's shell and left literal here, so the
 * pattern this script searches with is not the pattern CI searches with. */
const SHELL_TOKEN =
	/\\([\s\S])|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|\$[({[0-9!#?*@$-]|`/g;

function refuse(reason, detail) {
	console.error(`The attribution scan cannot be run: ${reason}`);
	if (detail !== undefined) {
		console.error(`  ${detail}`);
	}
	process.exit(1);
}

/** This is the one call that sets no `stdio`, so a failing `git` inherits stderr, and the
 * refusal that reads it reports `String(error)`, whose message is the whole argument vector.
 * Every call passes `log`, `ls-files` or `rev-list` with pathspecs and none carries a pattern,
 * so nothing leaks today — it is the one path where the audit behind E-1482 is absent rather
 * than applied, and E-1487 states that rather than leaving it to be rediscovered. */
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
			/** execFileSync writes the child's stderr to this process's stderr unless stdio says
			 * otherwise, so a search tool rejecting a pattern prints it whatever this script then
			 * does with the message. It is captured here and never forwarded (E-1482). */
			stdio: ["pipe", "pipe", "pipe"],
			...options,
		});
		return { matched: true, hits };
	} catch (error) {
		if (error.status === 1) {
			return { matched: false, hits: "" };
		}
		/** Neither the argument vector nor the command's own message. Which tools quote a rejected
		 * pattern back depends on which one the path resolves: `git grep` does, ugrep 7.8.4 prints
		 * it under a caret, and BSD grep 2.6.0-FreeBSD does not — so withholding is the only
		 * answer that does not depend on that. What is reported is the command and its status,
		 * and the message is lost, which is the trade the rest of this file makes (E-1482,
		 * E-1488). */
		refuse(
			`the ${what} scan could not run, so it proves nothing`,
			`${command} exited ${String(error.status ?? error.code)}, and its message is withheld because both search tools quote a pattern they reject`,
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
	const unperformed = [];
	const value = raw.replace(SHELL_TOKEN, (token, escaped, braced, bare) => {
		if (escaped !== undefined) {
			return SHELL_ESCAPED.has(escaped) ? escaped : `\\${escaped}`;
		}
		const name = braced ?? bare;
		if (name === EXPANDED_HERE) {
			return assistants;
		}
		unperformed.push(name === undefined ? token : `$${name}`);
		return "";
	});
	if (unperformed.length > 0) {
		/** The expansions are named and the value is not: a refusal that prints the derived
		 * pattern states it in a second place, which is what this script exists to avoid. */
		refuse(
			`${DETECTOR}'s ${what} contains ${unperformed.length} shell expansion${unperformed.length === 1 ? "" : "s"} this script does not perform`,
			`${unperformed.join(", ")} — the pattern itself is not printed here`,
		);
	}
	return value;
}

/** A representative character for each POSIX class an extended regular expression may name, and
 * the candidates a negated bracket expression is sampled from. */
const POSIX_CLASS = new Map([
	["[:alnum:]", "a"],
	["[:alpha:]", "a"],
	["[:blank:]", " "],
	["[:cntrl:]", "\t"],
	["[:digit:]", "0"],
	["[:graph:]", "a"],
	["[:lower:]", "a"],
	["[:print:]", "a"],
	["[:punct:]", "."],
	["[:space:]", " "],
	["[:upper:]", "A"],
	["[:word:]", "a"],
	["[:xdigit:]", "0"],
]);
const OUTSIDE_A_NEGATED_CLASS = ["x", "0", " ", "-", "."];
const INTERVAL = /^\{(\d+)(?:,\d*)?\}/;

function membersOf(text) {
	const characters = new Set();
	for (let at = 0; at < text.length; at += 1) {
		if (text[at + 1] === "-" && text[at + 2] !== undefined) {
			for (let code = text.charCodeAt(at); code <= text.charCodeAt(at + 2); code += 1) {
				characters.add(String.fromCharCode(code));
			}
			at += 2;
			continue;
		}
		characters.add(text[at]);
	}
	return characters;
}

function readBracketExpression(reader) {
	reader.at += 1;
	const negated = reader.source[reader.at] === "^";
	if (negated) {
		reader.at += 1;
	}
	let members = "";
	const classes = [];
	if (reader.source[reader.at] === "]") {
		members += "]";
		reader.at += 1;
	}
	while (reader.at < reader.source.length && reader.source[reader.at] !== "]") {
		if (reader.source.startsWith("[:", reader.at)) {
			const end = reader.source.indexOf(":]", reader.at);
			if (end === -1) {
				break;
			}
			classes.push(reader.source.slice(reader.at, end + 2));
			reader.at = end + 2;
			continue;
		}
		members += reader.source[reader.at];
		reader.at += 1;
	}
	reader.at += 1;
	return { members, classes, negated };
}

function bracketSample(reader, bracket) {
	const characters = membersOf(bracket.members);
	for (const name of bracket.classes) {
		const representative = POSIX_CLASS.get(name);
		if (representative === undefined) {
			reader.unsampled.push(`an unknown character class ending at offset ${reader.at}`);
			return "";
		}
		characters.add(representative);
	}
	if (bracket.negated) {
		const outside = OUTSIDE_A_NEGATED_CLASS.find((candidate) => !characters.has(candidate));
		if (outside === undefined) {
			reader.unsampled.push(`a negated bracket expression ending at offset ${reader.at}`);
		}
		return outside ?? "";
	}
	const [first] = characters;
	if (first === undefined) {
		reader.unsampled.push(`an empty bracket expression ending at offset ${reader.at}`);
	}
	return first ?? "";
}

function readGroup(reader) {
	reader.at += 1;
	const sample = sampleBranch(reader, true);
	let depth = 1;
	while (reader.at < reader.source.length && depth > 0) {
		const character = reader.source[reader.at];
		if (character === "\\") {
			reader.at += 2;
			continue;
		}
		if (character === "[") {
			readBracketExpression(reader);
			continue;
		}
		depth += character === "(" ? 1 : 0;
		depth -= character === ")" ? 1 : 0;
		reader.at += 1;
	}
	return sample;
}

function readAtom(reader) {
	const character = reader.source[reader.at];
	if (character === "\\") {
		reader.at += 2;
		return reader.source[reader.at - 1] ?? "";
	}
	if (character === "(") {
		return readGroup(reader);
	}
	if (character === "[") {
		return bracketSample(reader, readBracketExpression(reader));
	}
	reader.at += 1;
	if (character === "^" || character === "$") {
		return "";
	}
	return character === "." ? "x" : character;
}

function readRepetition(reader) {
	const character = reader.source[reader.at];
	if (character === "*" || character === "?") {
		reader.at += 1;
		return 0;
	}
	if (character === "+") {
		reader.at += 1;
		return 1;
	}
	if (character !== "{") {
		return 1;
	}
	const interval = INTERVAL.exec(reader.source.slice(reader.at));
	if (interval === null) {
		return 1;
	}
	reader.at += interval[0].length;
	return Number(interval[1]);
}

/** One branch of an extended regular expression, sampled as the shortest string it accepts:
 * the first arm of every alternation, no optional part, one repetition where one is required. */
function sampleBranch(reader, insideGroup) {
	let sample = "";
	while (reader.at < reader.source.length) {
		const character = reader.source[reader.at];
		if (character === "|" || (character === ")" && insideGroup)) {
			break;
		}
		sample += readAtom(reader).repeat(readRepetition(reader));
	}
	return sample;
}

function samplesOf(pattern) {
	const reader = { source: pattern, at: 0, unsampled: [] };
	const samples = [];
	do {
		samples.push(sampleBranch(reader, false));
		reader.at += 1;
	} while (reader.at <= pattern.length);
	return { samples, unsampled: reader.unsampled };
}

function ordinalsOf(samples, unwanted) {
	return samples.flatMap((sample, index) => (unwanted(sample) ? [index + 1] : [])).join(", ");
}

/** Every top-level branch of a derived pattern is required to match a string built from that
 * branch, so a branch mangled into something unmatchable is found wherever it sits and not only
 * where it happens to be first. The samples come from the derived pattern, so what they
 * establish is that every branch is live and matchable and not that the derivation is faithful;
 * the two probes below are the independent half of that, and neither half sees a branch the
 * detector no longer states at all (E-1477, E-1478).
 *
 * It is also what makes an expansion missing from SHELL_TOKEN fail loudly rather than quietly:
 * the remnant is a literal `$` mid-branch, the sample built for that branch drops it, and the
 * branch then fails against its own sample. That holds where the engine treats a mid-pattern `$`
 * as an anchor or as an ordinary character, and fails where an engine ignores one. Measured on
 * BSD grep 2.6.0-FreeBSD, which is what this machine resolves `grep` to: `a$b` matches neither
 * `a$b` nor `ab`. **Not measured on GNU grep, which is what CI runs** — it is on no path here and
 * no container was available (E-1485). */
function provesEveryBranch(what, pattern) {
	const { samples, unsampled } = samplesOf(pattern);
	if (unsampled.length > 0) {
		refuse(
			`${DETECTOR}'s ${what} uses ${unsampled.length} construct${unsampled.length === 1 ? "" : "s"} this script cannot build a sample from`,
			`${unsampled.join(", ")} — a branch nothing samples is a branch nothing proves`,
		);
	}
	const blank = ordinalsOf(samples, (sample) => sample === "");
	if (blank !== "") {
		refuse(
			`${DETECTOR}'s ${what} has branches that sample to the empty string`,
			`branch ${blank} of ${samples.length} — a branch matching everything finds nothing in particular`,
		);
	}
	const unmatched = ordinalsOf(
		samples,
		(sample) =>
			!searched(`${what} self-test`, "grep", ["-Eani", "-e", pattern], { input: sample }).matched,
	);
	if (unmatched !== "") {
		refuse(
			`${DETECTOR}'s ${what} does not match the sample built from every branch of it`,
			`branch ${unmatched} of ${samples.length} — the derivation lost what that branch matches`,
		);
	}
	return samples.length;
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

const markerBranches = provesEveryBranch("marker pattern", markers);
const claimBranches = provesEveryBranch("claim pattern", claims);

/** The two probes the samples above cannot be: they are built here rather than from the derived
 * pattern, so they answer whether the derivation still matches text a person would write. They
 * reach one branch of each pattern, which is why they are not the whole self-test. */
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
	`attribution: ${markerBranches} marker and ${claimBranches} claim branches proved, then ${commits} commit messages in ${range}, ${files} tracked files and ${diff.length} bytes of diff searched with ${DETECTOR}'s own patterns, no finding`,
);
