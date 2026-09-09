import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const workflow = readFileSync(`${repositoryRoot}/.github/workflows/ci.yml`, "utf8");

const STEP = "- name: Reject AI attribution";
const BLOCK_SCALAR = /^(\s*)run: \|\s*$/;

/**
 * The step's own convention: a search reports three states, and the third ends the job.
 * Nothing enforced it, so the fourth scan in the step went back to discarding its
 * consumer's status and only a plant found it (E-807). This is that enforcement.
 *
 * The matchers are enumerated rather than inferred, so a scan built on a command not
 * named here is invisible to every assertion below (E-812).
 */
const MATCHER = /(?:^|[|;&(]|\bxargs\s+)\s*(?:git\s+)?(?:grep|awk|cmp)\b/;
const STATUS_CAPTURED = /\|\|\s*([A-Za-z_][A-Za-z0-9_]*)=\$\?\s*$/;
const STATUS_DISCARDED = /\|\|\s*(?::|true)\s*(?:$|[;)])/;
const PIPELINE_AS_CONDITION = /^(?:if|while|until)\b[^\n]*[^|]\|[^|]/;
const VARIABLE_REFERENCE = /"\$([A-Za-z_][A-Za-z0-9_]*)"|\bcase\s+"\$([A-Za-z_][A-Za-z0-9_]*)"/g;
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

describe("the attribution step reads every status it depends on", () => {
	const body = attributionStepBody();
	const commands = commandLines(body);
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

	/** Every default branch, not merely one of them: neutering either leaves the other. */
	it("refuses in every default branch it has", () => {
		const defaults = commands.filter((command) => DEFAULT_BRANCH.test(command));
		expect(defaults.length).toBeGreaterThan(0);
		expect(defaults.filter((command) => !REFUSES.test(command))).toEqual([]);
	});

	it("discards no status", () => {
		expect(commands.filter((command) => STATUS_DISCARDED.test(command))).toEqual([]);
	});

	it("reads no pipeline as a condition", () => {
		expect(commands.filter((command) => PIPELINE_AS_CONDITION.test(command))).toEqual([]);
	});
});
