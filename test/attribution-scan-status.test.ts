import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const workflow = readFileSync(`${repositoryRoot}/.github/workflows/ci.yml`, "utf8");

const STEP = "- name: Reject AI attribution";
const BLOCK_SCALAR = /^(\s*)run: \|\s*$/;
const ASSISTANTS = /^\s*ASSISTANTS: '([^']+)'/m;

/**
 * The step's own convention: a status is read for every state it can carry, and the one
 * meaning "could not look" ends the job. Nothing enforced it, so the fourth scan in the
 * step went back to discarding its consumer's status and only a plant found it (E-807).
 *
 * The structural half below is one spelling deep by construction and cannot see a
 * refusal that is deleted or inverted rather than misspelt; the behavioural half is what
 * covers the semantic, and E-815 is why both are here.
 */
const MATCHER = /(?:^|[|;&(]|\bxargs\s+)\s*(?:git\s+)?(?:grep|awk|cmp)\b/;
const STATUS_CAPTURED = /\|\|\s*([A-Za-z_][A-Za-z0-9_]*)=\$\?\s*$/;
const STATUS_DISCARDED = /\|\|\s*(?::|true)\s*(?:$|[;)])/;
const PIPELINE_AS_CONDITION = /^(?:if|while|until)\b[^\n]*[^|]\|[^|]/;
const VARIABLE_REFERENCE = /"\$([A-Za-z_][A-Za-z0-9_]*)"|\bcase\s+"\$([A-Za-z_][A-Za-z0-9_]*)"/g;
const CASE_OPENER = /^case\s/;
const DEFAULT_BRANCH = /^\*\)/;
const REFUSES = /\brefuse\b/;

/** The block scalar runs to the first line indented no further than its own `run:` key. */
function attributionStepBody(): string {
	const stepStart = workflow.indexOf(STEP);
	if (stepStart === -1) {
		throw new Error(`${STEP} is not in .github/workflows/ci.yml`);
	}
	const lines = workflow.slice(stepStart).split("\n");
	const opener = lines.findIndex((line) => BLOCK_SCALAR.test(line));
	if (opener === -1) {
		throw new Error(`${STEP} carries no block scalar`);
	}
	const keyIndent = String(BLOCK_SCALAR.exec(String(lines[opener]))?.[1]).length;
	const body: string[] = [];
	for (const line of lines.slice(opener + 1)) {
		const indent = line.length - line.trimStart().length;
		if (line.trim() !== "" && indent <= keyIndent) {
			break;
		}
		body.push(line.slice(keyIndent + 2));
	}
	return body.join("\n");
}

/** A trailing backslash continues a command, so the status at the end of it is one line's. */
function commandLines(body: string): string[] {
	const joined: string[] = [];
	let pending = "";
	for (const line of body.split("\n")) {
		const text = line.trim();
		if (text.startsWith("#")) {
			continue;
		}
		pending = pending === "" ? text : `${pending} ${text}`;
		if (pending.endsWith("\\")) {
			pending = pending.slice(0, -1).trimEnd();
			continue;
		}
		if (pending !== "") {
			joined.push(pending);
		}
		pending = "";
	}
	return joined;
}

function capturedStatus(command: string): string | undefined {
	return STATUS_CAPTURED.exec(command)?.[1];
}

const body = attributionStepBody();
const commands = commandLines(body);

describe("the attribution step reads every status it depends on", () => {
	const matchers = commands.filter((command) => MATCHER.test(command));
	const captures = commands.map(capturedStatus).filter((name) => name !== undefined);

	it("finds a step body with matchers in it to examine", () => {
		expect(body.length).toBeGreaterThan(0);
		expect(commands.length).toBeGreaterThan(0);
		expect(matchers.length).toBeGreaterThan(0);
		expect(captures.length).toBeGreaterThan(0);
	});

	it("captures the status of every matcher it runs", () => {
		expect(matchers.filter((command) => capturedStatus(command) === undefined)).toEqual([]);
	});

	/**
	 * Order, not membership. Handing `report` a status captured for a different scan
	 * leaves every name still present and is exactly the evasion this catches (E-812).
	 */
	it("consumes each captured status before the next one is captured", () => {
		const declared = new Set(captures);
		const consumed: string[] = [];
		for (const command of commands) {
			for (const [, quoted, inCase] of command.matchAll(VARIABLE_REFERENCE)) {
				const name = quoted ?? inCase;
				if (name !== undefined && declared.has(name)) {
					consumed.push(name);
				}
			}
		}
		expect(consumed).toEqual(captures);
	});

	/**
	 * Counted against the cases that exist, not against the branches that survive: an
	 * assertion over "every default branch" is satisfied by deleting one (E-815).
	 */
	it("refuses in the default branch of every case it opens", () => {
		const cases = commands.filter((command) => CASE_OPENER.test(command));
		const defaults = commands.filter((command) => DEFAULT_BRANCH.test(command));
		expect(cases.length).toBeGreaterThan(0);
		expect(defaults.length).toEqual(cases.length);
		expect(defaults.filter((command) => !REFUSES.test(command))).toEqual([]);
	});

	it("discards no status", () => {
		expect(commands.filter((command) => STATUS_DISCARDED.test(command))).toEqual([]);
	});

	it("reads no pipeline as a condition", () => {
		expect(commands.filter((command) => PIPELINE_AS_CONDITION.test(command))).toEqual([]);
	});
});

/** The literal would itself be a finding in this file, so it is assembled (CLAUDE.md §4). */
const PLANTED_MARKER = ["Gener", "ated ", "with"].join("");

const scratchDirectories: string[] = [];

function plantedRepository(build: (directory: string) => void): string {
	const directory = mkdtempSync(join(tmpdir(), "velve-attribution-"));
	scratchDirectories.push(directory);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: directory, stdio: "pipe", encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "plant@example.invalid");
	git("config", "user.name", "Plant");
	writeFileSync(join(directory, "README.md"), "a repository with nothing to find\n");
	build(directory);
	git("add", "-A");
	git("commit", "-q", "-m", "chore: start");
	git("update-ref", "refs/remotes/origin/main", "HEAD");
	return directory;
}

function runStep(directory: string, brokenCommand?: string): number {
	const script = join(directory, "attribution-step.sh");
	writeFileSync(script, body);
	let path = String(process.env.PATH);
	if (brokenCommand !== undefined) {
		const shims = join(directory, "shims");
		mkdirSync(shims, { recursive: true });
		const shim = join(shims, brokenCommand);
		writeFileSync(shim, "#!/bin/sh\nexit 2\n");
		chmodSync(shim, 0o755);
		path = `${shims}:${path}`;
	}
	const assistants = ASSISTANTS.exec(workflow)?.[1];
	if (assistants === undefined) {
		throw new Error("the step declares no ASSISTANTS");
	}
	const finished = spawnSync("bash", ["-e", script], {
		cwd: directory,
		env: { ...process.env, PATH: path, ASSISTANTS: assistants },
		encoding: "utf8",
	});
	return finished.status ?? -1;
}

afterAll(() => {
	for (const directory of scratchDirectories) {
		rmSync(directory, { recursive: true, force: true });
	}
});

/**
 * A refusal that is deleted or inverted rather than misspelt passes every structural
 * assertion above, and both mutations restore a false pass at runtime (E-815). Only
 * running the step catches that, so these run it.
 */
describe("the attribution step refuses when a scan cannot run", () => {
	it("passes a repository with nothing to find", () => {
		expect(runStep(plantedRepository(() => {}))).toBe(0);
	});

	it("fails on a marker in a tracked file", () => {
		const directory = plantedRepository((where) => {
			writeFileSync(join(where, "planted.txt"), `${PLANTED_MARKER} something.\n`);
		});
		expect(runStep(directory)).toBe(1);
	});

	it("fails when grep cannot run", () => {
		expect(
			runStep(
				plantedRepository(() => {}),
				"grep",
			),
		).toBe(1);
	});

	it("fails when awk cannot run", () => {
		const directory = plantedRepository((where) => {
			symlinkSync("README.md", join(where, "planted-link.md"));
		});
		expect(runStep(directory, "awk")).toBe(1);
	});

	it("fails when cmp cannot run", () => {
		expect(
			runStep(
				plantedRepository(() => {}),
				"cmp",
			),
		).toBe(1);
	});
});
