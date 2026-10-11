import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * `check:log-append` excuses deleted lines for exactly one change, the central pass that replaces
 * the German entries with their translations (E-2990). Every case here plants a log at a merge
 * base, commits a change on top of it and runs the tool in that repository, so a check that
 * excused too much or too little is caught by a fault it was shown, not by a reading of its source.
 */
const HEADER = [
	"# Velve Auth — the complete decision log",
	"",
	"An English preamble.",
	"",
	"---",
	"",
	"# Velve Auth — Fallstudie",
	"",
	"Dieses Protokoll ist der Ausgangsbestand.",
	"",
	"---",
	"",
	"### Laufzeit und Auslieferung",
	"",
];

const GERMAN_E01 = [
	'<a id="e-01"></a>',
	"",
	"**E-01 — Reines TypeScript.**",
	"*Kontext:* Argon2id ist teuer.",
	"*Verworfen:* Rust.",
	"*Grund:* Ortsunabhängigkeit.",
	"*Preis:* 263 ms.",
	"",
];

const GERMAN_E47 = [
	'<a id="e-47"></a>',
	"",
	"**E-47 — Englisch als Repository-Sprache.**",
	"*Kontext:* Der Auftrag ist auf Deutsch.",
	"*Verworfen:* Deutsch.",
	"*Grund:* Die Leser.",
	"*Preis:* Zweisprachig.",
	"",
	"**Licence addendum.** The *Kontext* above says MIT because that is what the",
	"package was when this entry was written.",
	"",
];

const ENGLISH_E60 = [
	'<a id="e-60"></a>',
	"",
	"### The keys are exportable",
	"`E-60` · keys · storage format, frozen",
	"",
	"**Context.** A context.",
	"**Rejected.** Nothing.",
	"**Reason.** A reason.",
	"**Price.** A price.",
	"",
];

function translated(anchor: string, number: string, owner: string, tag: string): string[] {
	return [
		anchor,
		"",
		"### Pure TypeScript",
		`\`${number}\` · ${owner} · ${tag}`,
		"",
		"**Context.** Argon2id is expensive.",
		"**Rejected.** Rust.",
		"**Reason.** Independence of location.",
		"**Price.** 263 ms.",
		"",
	];
}

const TAG = "translated from the German original";
const TRANSLATED_E01 = translated('<a id="e-01"></a>', "E-01", "architecture", TAG);
const TRANSLATED_E47 = [
	'<a id="e-47"></a>',
	"",
	"### English as the repository language",
	`\`E-47\` · scaffold · ${TAG}`,
	"",
	"**Context.** The brief is in German.",
	"**Rejected.** German.",
	"**Reason.** The readers.",
	"**Price.** Bilingual.",
	"",
	"**Licence addendum.** The *Kontext* above says MIT because that is what the",
	"package was when this entry was written.",
	"",
];

const BASE_LOG = [...HEADER, ...GERMAN_E01, ...GERMAN_E47, ...ENGLISH_E60];

const scratchDirectories: string[] = [];

afterAll(() => {
	for (const directory of scratchDirectories) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function runAgainstChange(changed: string[]): { status: number; output: string } {
	const directory = mkdtempSync(join(tmpdir(), "velve-log-append-"));
	scratchDirectories.push(directory);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: directory, stdio: "pipe", encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "plant@example.invalid");
	git("config", "user.name", "Plant");
	mkdirSync(join(directory, "tools"));
	mkdirSync(join(directory, "docs", "decisions"), { recursive: true });
	copyFileSync(
		join(repositoryRoot, "tools", "check-log-append.mjs"),
		join(directory, "tools", "check-log-append.mjs"),
	);
	const log = join(directory, "docs", "decisions", "log.md");
	writeFileSync(log, `${BASE_LOG.join("\n")}\n`);
	git("add", "-A");
	git("commit", "-q", "-m", "chore: base");
	const base = git("rev-parse", "HEAD").trim();
	writeFileSync(log, `${changed.join("\n")}\n`);
	git("commit", "-q", "-am", "docs: change");
	const finished = spawnSync("node", ["tools/check-log-append.mjs"], {
		cwd: directory,
		env: { ...process.env, VELVE_LOG_BASE: base },
		encoding: "utf8",
	});
	return { status: finished.status ?? -1, output: `${finished.stdout}${finished.stderr}` };
}

const APPENDED = [...ENGLISH_E60.slice(0, -1), "", "An appended line.", ""];

describe("check:log-append and the central translation pass", () => {
	it("passes a branch that only appends", () => {
		const result = runAgainstChange([...BASE_LOG, "An appended line.", ""]);
		expect(result.output).toContain("+2 -0 committed");
		expect(result.status).toBe(0);
	});

	it("passes one German entry replaced by its translation under the same anchor", () => {
		const result = runAgainstChange([...HEADER, ...TRANSLATED_E01, ...GERMAN_E47, ...APPENDED]);
		expect(result.output).toContain("replaced by translation");
		expect(result.status).toBe(0);
	});

	it("passes the German header and section heading replaced by their translation", () => {
		const header = [
			...HEADER.slice(0, 6),
			"# Velve Auth — the log before the build",
			"",
			"This log is the starting stock.",
			"",
			"---",
			"",
			"### Runtime and delivery",
			"",
		];
		const result = runAgainstChange([...header, ...GERMAN_E01, ...GERMAN_E47, ...ENGLISH_E60]);
		expect(result.status).toBe(0);
	});

	it("passes a translated entry that keeps the English paragraph standing", () => {
		const result = runAgainstChange([...HEADER, ...GERMAN_E01, ...TRANSLATED_E47, ...ENGLISH_E60]);
		expect(result.status).toBe(0);
	});

	it("fails a German entry deleted without an English replacement", () => {
		const result = runAgainstChange([...HEADER, ...GERMAN_E47, ...APPENDED]);
		expect(result.output).toContain("**E-01 — Reines TypeScript.**");
		expect(result.status).toBe(1);
	});

	it("fails an English entry edited", () => {
		const edited = ENGLISH_E60.map((line) =>
			line === "**Reason.** A reason." ? "**Reason.** A better reason." : line,
		);
		const result = runAgainstChange([...HEADER, ...GERMAN_E01, ...GERMAN_E47, ...edited]);
		expect(result.output).toContain("-**Reason.** A reason.");
		expect(result.status).toBe(1);
	});

	it("fails an English entry deleted", () => {
		const result = runAgainstChange([
			...HEADER,
			...TRANSLATED_E01,
			...GERMAN_E47,
			"An appended line.",
		]);
		expect(result.output).toContain("### The keys are exportable");
		expect(result.status).toBe(1);
	});

	it("fails a translation whose anchor was changed", () => {
		const moved = translated('<a id="e-1"></a>', "E-01", "architecture", TAG);
		const result = runAgainstChange([...HEADER, ...moved, ...GERMAN_E47, ...ENGLISH_E60]);
		expect(result.output).toContain('<a id="e-01"></a>');
		expect(result.status).toBe(1);
	});

	it("fails a translation that does not carry the fixed tag", () => {
		const untagged = translated('<a id="e-01"></a>', "E-01", "architecture", "settled");
		const result = runAgainstChange([...HEADER, ...untagged, ...GERMAN_E47, ...ENGLISH_E60]);
		expect(result.status).toBe(1);
	});

	it("fails a translation that names another number under the anchor", () => {
		const renumbered = translated('<a id="e-01"></a>', "E-02", "architecture", TAG);
		const result = runAgainstChange([...HEADER, ...renumbered, ...GERMAN_E47, ...ENGLISH_E60]);
		expect(result.status).toBe(1);
	});

	it("fails a translation that drops the English paragraph inside the German entry", () => {
		const result = runAgainstChange([
			...HEADER,
			...GERMAN_E01,
			...TRANSLATED_E47.slice(0, -3),
			...ENGLISH_E60,
		]);
		expect(result.output).toContain("**Licence addendum.**");
		expect(result.status).toBe(1);
	});
});
