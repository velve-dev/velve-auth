import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const rules = readFileSync(`${repositoryRoot}/CLAUDE.md`, "utf8");
const workflow = readFileSync(`${repositoryRoot}/.github/workflows/ci.yml`, "utf8");
const release = readFileSync(`${repositoryRoot}/.github/workflows/release.yml`, "utf8");
const manifest = JSON.parse(readFileSync(`${repositoryRoot}/package.json`, "utf8")) as {
	scripts: Record<string, string>;
};

/** §9 is the command reference, so it names commands the gate does not run. Two are run by a
 * person and by nothing else — the formatter and the gate itself — and five are run by
 * release.yml: the two tiers section 6 puts on a schedule rather than on a commit (E-526, E-535),
 * the two release checks §9 documents and §5's checklist deliberately does not, because one
 * refuses a branch carrying no tag and the other a version nobody has published (E-1461), and the
 * derivation that decides which dist-tag the release publishes under (E-1777).
 * Anything else appearing in §9 without appearing in the gate script is drift. */
const RUN_BY_A_PERSON = ["format", "gate"];
const RUN_BY_THE_RELEASE_WORKFLOW = [
	"test:nightly",
	"test:release",
	"check:release-tag",
	"check:published-version",
	"dist-tag",
];
const NOT_RUN_BY_THE_GATE = [...RUN_BY_A_PERSON, ...RUN_BY_THE_RELEASE_WORKFLOW];

/** The one pnpm invocation in the workflow that is not a gate step. */
const CI_SETUP = ["install"];

/** The one gate step ci.yml runs as a job rather than as a step. `pnpm check:attribution` reads
 * its patterns out of the `attribution` job and searches the same surfaces, so a step for it in
 * the gate job would be a second run of what the workflow already does on every push. The
 * exemption is asserted against the job it names rather than merely listed (E-1464). */
const RUN_BY_CI_AS_A_JOB_OF_ITS_OWN = ["check:attribution"];

/** A second, independent statement of the detector's shape, in a file that is not the detector.
 * `pnpm check:attribution` derives everything it searches with from the `attribution` job, so it
 * proves the branches that are there and cannot see one the job no longer states — a deletion
 * narrows the scan silently. Counts are not patterns, so stating them here trips no scan. Floors
 * rather than exact numbers, because adding a branch is not a narrowing (E-1478). */
const DETECTOR_STATES_AT_LEAST = { assistants: 7, markers: 6, claims: 3 };

/** A backslash escape or a whole bracket expression, including a POSIX class carrying its own
 * `]`. Removing these leaves only the structure the count below is about. */
const ESCAPE_OR_BRACKET = /\\[\s\S]|\[\^?\]?(?:\[:[a-z]+:\]|[^\]])*\]/g;

/** A `|` outside every group and bracket expression. Counted here rather than read through the
 * check's own parser, which would agree with the check whatever that parser did (E-537). */
function topLevelAlternatives(pattern: string): number {
	let depth = 0;
	let alternatives = 1;
	for (const character of pattern.replace(ESCAPE_OR_BRACKET, "")) {
		if (character === "(") {
			depth += 1;
		}
		if (character === ")") {
			depth -= 1;
		}
		if (character === "|" && depth === 0) {
			alternatives += 1;
		}
	}
	return alternatives;
}

/** A job runs to the next job heading and not to the end of the file. Slicing to the end pins
 * every assertion below to whichever job happens to be last, which `attribution` is today and
 * need not stay (E-1479). */
function jobRegion(source: string, name: string): string {
	const start = source.indexOf(`\n  ${name}:`);
	if (start === -1) {
		return "";
	}
	const rest = source.slice(start + 1);
	const end = rest.search(/\n {2}[A-Za-z0-9_-]+:\n/);
	return end === -1 ? rest : rest.slice(0, end);
}

/** Anchored to the start of a YAML scalar, and reading the script name rather than searching
 * for it: `workflow.includes("run: pnpm test")` is satisfied by a step commented out and by
 * `run: pnpm test:release`, and both of those remove the step from CI while staying green. */
const WORKFLOW_STEP = /^[ \t]*(?:- )?run: pnpm ([\w:-]+)/gm;

function section(heading: string): string {
	const start = rules.indexOf(heading);
	expect(start, `CLAUDE.md has no ${heading}`).toBeGreaterThan(-1);
	const rest = rules.slice(start + heading.length);
	const end = rest.search(/\n#{1,3} /);
	return end === -1 ? rest : rest.slice(0, end);
}

function invoked(script: string): string[] {
	return [...script.matchAll(/\bpnpm ([\w:-]+)/g)].map((match) => String(match[1]));
}

const gateSteps = invoked(manifest.scripts.gate ?? "");
const gateList = [...section("### The main gate").matchAll(/`pnpm ([\w:-]+)`/g)].map((match) =>
	String(match[1]),
);
const commandList = [...section("## 9. Commands").matchAll(/^pnpm ([\w:-]+)/gm)].map((match) =>
	String(match[1]),
);

const sorted = (names: string[]) => [...new Set(names)].sort();

describe("the gate's command lists", () => {
	it("reads a gate script that is more than one step", () => {
		expect(gateSteps.length).toBeGreaterThan(5);
		expect(gateList.length).toBeGreaterThan(5);
		expect(commandList.length).toBeGreaterThan(5);
	});

	// A name written in a list is not a command that exists. E-495 fixed these lists by reading
	// them and left one omission standing, so the reading is done here instead.
	// §9 says pnpm gate runs everything "in the order the main gate runs it", so the order is part
	// of the claim and a sorted comparison would pass for any permutation of it.
	it("names in §5 exactly the commands the gate script runs, in that order", () => {
		expect(gateList).toEqual(gateSteps);
	});

	it("names in §9 every command the gate runs, and nothing beyond the seven it declares", () => {
		expect(sorted(commandList)).toEqual(sorted([...gateSteps, ...NOT_RUN_BY_THE_GATE]));
	});

	it("resolves every listed command to a script that exists", () => {
		const unresolved = sorted([...gateSteps, ...gateList, ...commandList]).filter(
			(name) => manifest.scripts[name] === undefined,
		);
		expect(unresolved).toEqual([]);
	});

	it("resolves every check to the file it runs", () => {
		const missing = Object.entries(manifest.scripts)
			.filter(([name]) => name.startsWith("check:"))
			.map(([name, script]) => ({ name, path: script.replace(/^node /, "") }))
			.filter((check) => !existsSync(`${repositoryRoot}/${check.path}`))
			.map((check) => `${check.name} runs ${check.path}, which is not there`);
		expect(missing).toEqual([]);
	});

	// Every name §9 is allowed to carry beyond the gate's own steps says where it does run, and
	// the half of that answer naming a workflow is read out of the workflow. Without this the
	// exemption list is a hole in the comparison above: a name added to it is documented, exempt
	// from the gate, and run by nothing.
	it("runs in release.yml every command exempted on the grounds that the release runs it", () => {
		const invoked = [...release.matchAll(WORKFLOW_STEP)].map((match) => String(match[1]));

		expect(invoked.length).toBeGreaterThan(4);
		expect(RUN_BY_THE_RELEASE_WORKFLOW.filter((name) => !invoked.includes(name))).toEqual([]);
	});

	// The gate list and CI are two statements of the same set, and CI is the one that blocks a
	// merge. A step present in the script and absent from the workflow runs for nobody but the
	// author, and a step in the workflow that the script does not run blocks nobody locally.
	it("runs in CI exactly the commands the gate script runs", () => {
		const inWorkflow = [...workflow.matchAll(WORKFLOW_STEP)].map((match) => String(match[1]));
		const asSteps = gateSteps.filter((name) => !RUN_BY_CI_AS_A_JOB_OF_ITS_OWN.includes(name));

		expect(asSteps.length).toBe(gateSteps.length - RUN_BY_CI_AS_A_JOB_OF_ITS_OWN.length);
		expect(sorted(inWorkflow)).toEqual(sorted([...asSteps, ...CI_SETUP]));
	});

	// Subtracting a name from the comparison above without checking what it names is the same
	// hole the §9 exemption had. The job is asserted, and so are the three definitions the
	// subtracted step reads out of it — losing any of them leaves that step with nothing to
	// derive its patterns from, and it refuses rather than passing.
	it("declares the job the subtracted gate step reads its patterns from", () => {
		const job = jobRegion(workflow, "attribution");

		expect(job).not.toBe("");
		expect(job).toMatch(/^ +ASSISTANTS: '/m);
		expect(job).toMatch(/^ +MARKERS="/m);
		expect(job).toMatch(/^ +CLAIMS="/m);
	});

	// The check derives its patterns from that job, so a branch deleted from one of them narrows
	// the scan and the check reports a clean tree over the rest. Measured: five of the six marker
	// branches removed and all five markers planted leaves it at exit 0. This is the statement
	// that is not derived from the job, so it is the one that can fail on a deletion.
	it("states a detector whose patterns still carry every branch the scan is meant to have", () => {
		const job = jobRegion(workflow, "attribution");
		const value = (shape: RegExp) => String(shape.exec(job)?.[1] ?? "");

		expect(value(/^ +ASSISTANTS: '([^']+)'$/m).split("|").length).toBeGreaterThanOrEqual(
			DETECTOR_STATES_AT_LEAST.assistants,
		);
		expect(topLevelAlternatives(value(/^ +MARKERS="(.+)"$/m))).toBeGreaterThanOrEqual(
			DETECTOR_STATES_AT_LEAST.markers,
		);
		expect(topLevelAlternatives(value(/^ +CLAIMS="(.+)"$/m))).toBeGreaterThanOrEqual(
			DETECTOR_STATES_AT_LEAST.claims,
		);
	});

	// The other half of §9's exemption says a person runs these, which is not assertable; that
	// no workflow runs them is, and it is the claim that would be false if one were automated
	// and left in this half. What it does not establish is that anybody runs them at all.
	it("runs in no workflow the commands exempted on the grounds that a person runs them", () => {
		const automated = [...workflow.matchAll(WORKFLOW_STEP), ...release.matchAll(WORKFLOW_STEP)].map(
			(match) => String(match[1]),
		);

		expect(automated.length).toBeGreaterThan(4);
		expect(RUN_BY_A_PERSON.filter((name) => automated.includes(name))).toEqual([]);
	});
});
