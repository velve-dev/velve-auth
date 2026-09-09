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
 */
const SEARCH_INVOCATION = /(?:^|[|;&(]|\bxargs\s+)\s*(?:git\s+)?grep\b/;
const STATUS_CAPTURED = /\|\|\s*([A-Za-z_][A-Za-z0-9_]*)=\$\?\s*$/;
const STATUS_DISCARDED = /\|\|\s*(?::|true)\s*(?:$|[;)])/;
const PIPELINE_AS_CONDITION = /^(?:if|while|until)\b[^\n]*[^|]\|[^|]/;
const REPORT_CALL = /^report\s/;
const VARIABLE_ARGUMENT = /"\$([A-Za-z_][A-Za-z0-9_]*)"/g;

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

describe("the attribution step reads every status it depends on", () => {
	const body = attributionStepBody();
	const commands = commandLines(body);
	const searches = commands.filter((command) => SEARCH_INVOCATION.test(command));

	it("finds a step body with searches in it to examine", () => {
		expect(body.length).toBeGreaterThan(0);
		expect(commands.length).toBeGreaterThan(0);
		expect(searches.length).toBeGreaterThan(0);
	});

	it("captures the status of every search it runs", () => {
		const uncaptured = searches.filter((command) => !STATUS_CAPTURED.test(command));
		expect(uncaptured).toEqual([]);
	});

	it("hands every captured status to report", () => {
		const captured = searches.map((command) => String(STATUS_CAPTURED.exec(command)?.[1]));
		const handedOver = new Set(
			commands
				.filter((command) => REPORT_CALL.test(command))
				.flatMap((command) => [...command.matchAll(VARIABLE_ARGUMENT)].map((match) => match[1])),
		);
		expect(captured.filter((name) => !handedOver.has(name))).toEqual([]);
	});

	it("discards no status", () => {
		expect(commands.filter((command) => STATUS_DISCARDED.test(command))).toEqual([]);
	});

	it("reads no pipeline as a condition", () => {
		expect(commands.filter((command) => PIPELINE_AS_CONDITION.test(command))).toEqual([]);
	});
});
